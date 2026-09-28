import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

// The application service owns cross-record transactions via CorptieStore.
// This repository never opens a separate connection or commits caller work.
export class ArtifactRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  createArtifactMetadata(input) {
    this.db.run(
      `INSERT INTO artifacts (
         artifact_id, work_id, title, summary, visibility, scope, kind,
         category_path, tags_json, aliases_json, keywords_json, bound_task_id,
         bound_session_id, repository_locator, source_session_id, source_event_id,
         created_by_actor_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId, input.workId, input.title, input.summary ?? "", input.visibility,
        input.scope ?? artifactScopeForVisibility(input.visibility), input.kind ?? "other",
        input.categoryPath ?? "", JSON.stringify(input.tags ?? []),
        JSON.stringify(input.aliases ?? []), JSON.stringify(input.keywords ?? []),
        input.boundTaskId ?? null, input.boundSessionId ?? null, input.repositoryLocator ?? null,
        input.sourceSessionId ?? null, input.sourceEventId ?? null, input.actorId,
        input.createdAt, input.createdAt
      ]
    );
    this.scheduleSave();
    return this.getArtifact(input.artifactId);
  }

  getArtifact(artifactId) {
    const row = this.selectOne(`SELECT * FROM artifacts WHERE artifact_id = ?`, [artifactId]);
    return row ? artifactFromRow(row) : null;
  }

  listArtifacts({ includeRevoked = false, limit = null, offset = 0 } = {}) {
    return this.selectAll(
      `SELECT * FROM artifacts ${includeRevoked ? "" : "WHERE status <> 'revoked'"}
       ORDER BY updated_at DESC, artifact_id ${limit == null ? "" : "LIMIT ? OFFSET ?"}`,
      limit == null ? [] : [limit, offset]
    ).map(artifactFromRow);
  }

  listArtifactsByWork(workId, { includeRevoked = false, limit = null, offset = 0 } = {}) {
    const pagination = limit == null ? "" : "LIMIT ? OFFSET ?";
    return this.selectAll(
      `SELECT * FROM artifacts WHERE work_id = ? ${includeRevoked ? "" : "AND status <> 'revoked'"}
       ORDER BY updated_at DESC, artifact_id ${pagination}`,
      limit == null ? [workId] : [workId, limit, offset]
    ).map(artifactFromRow);
  }

  countArtifactsByWork(workId, { includeRevoked = false } = {}) {
    return Number(this.selectOne(
      `SELECT COUNT(*) AS count FROM artifacts
       WHERE work_id = ? ${includeRevoked ? "" : "AND status <> 'revoked'"}`,
      [workId]
    )?.count ?? 0);
  }

  listArtifactsReferencedByTask(taskId, { includeRevokedReferences = false, limit = null, offset = 0 } = {}) {
    const pagination = limit == null ? "" : "LIMIT ? OFFSET ?";
    const params = [taskId];
    if (limit != null) params.push(limit, offset);
    return this.selectAll(
      `SELECT DISTINCT artifact.* FROM artifacts artifact
       JOIN artifact_references reference ON reference.artifact_id = artifact.artifact_id
       WHERE reference.task_id = ?
         ${includeRevokedReferences ? "" : "AND reference.revoked_at IS NULL"}
         AND artifact.status <> 'revoked'
       ORDER BY artifact.updated_at DESC, artifact.artifact_id ${pagination}`,
      params
    ).map(artifactFromRow);
  }

  countArtifactsReferencedByTask(taskId, { includeRevokedReferences = false } = {}) {
    return Number(this.selectOne(
      `SELECT COUNT(DISTINCT artifact.artifact_id) AS count FROM artifacts artifact
       JOIN artifact_references reference ON reference.artifact_id = artifact.artifact_id
       WHERE reference.task_id = ?
         ${includeRevokedReferences ? "" : "AND reference.revoked_at IS NULL"}
         AND artifact.status <> 'revoked'`, [taskId]
    )?.count ?? 0);
  }

  listArtifactVersionsByArtifactIds(artifactIds) {
    if (!Array.isArray(artifactIds) || artifactIds.length === 0) return [];
    return this.selectAll(
      `SELECT * FROM artifact_versions WHERE artifact_id IN (${artifactIds.map(() => "?").join(",")})
       ORDER BY artifact_id, version DESC`, artifactIds
    ).map(artifactVersionFromRow);
  }

  listArtifactReferencesByArtifactIds(artifactIds, { taskId = null, includeRevoked = false } = {}) {
    if (!Array.isArray(artifactIds) || artifactIds.length === 0) return [];
    const params = [...artifactIds];
    const taskClause = taskId ? "AND task_id = ?" : "";
    if (taskId) params.push(taskId);
    return this.selectAll(
      `SELECT * FROM artifact_references
       WHERE artifact_id IN (${artifactIds.map(() => "?").join(",")})
         ${taskClause} ${includeRevoked ? "" : "AND revoked_at IS NULL"}
       ORDER BY artifact_id, required DESC, authorized_at DESC`, params
    ).map(artifactReferenceFromRow);
  }

  listArtifactAuditByArtifactIds(artifactIds, perArtifactLimit = 100) {
    if (!Array.isArray(artifactIds) || artifactIds.length === 0) return [];
    return this.selectAll(
      `SELECT * FROM (
         SELECT event.*, ROW_NUMBER() OVER (
           PARTITION BY artifact_id ORDER BY created_at DESC, audit_id DESC
         ) AS artifact_row_number
         FROM artifact_audit_events event
         WHERE artifact_id IN (${artifactIds.map(() => "?").join(",")})
       ) WHERE artifact_row_number <= ?
       ORDER BY artifact_id, created_at DESC, audit_id DESC`,
      [...artifactIds, Math.max(1, Math.min(500, Number(perArtifactLimit) || 100))]
    ).map(artifactAuditFromRow);
  }

  updateArtifact(artifactId, patch = {}) {
    const current = this.getArtifact(artifactId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE artifacts SET title=?, summary=?, visibility=?, scope=?, kind=?, category_path=?,
       tags_json=?, aliases_json=?, keywords_json=?, bound_task_id=?, bound_session_id=?,
       repository_locator=?, current_version=?, approved_version=?, status=?, updated_at=?,
       resource_version=resource_version+1 WHERE artifact_id=?`,
      [
        has("title") ? patch.title : current.title,
        has("summary") ? patch.summary : current.summary,
        has("visibility") ? patch.visibility : current.visibility,
        has("scope") ? patch.scope : current.scope,
        has("kind") ? patch.kind : current.kind,
        has("categoryPath") ? patch.categoryPath : current.categoryPath,
        JSON.stringify(has("tags") ? patch.tags : current.tags),
        JSON.stringify(has("aliases") ? patch.aliases : current.aliases),
        JSON.stringify(has("keywords") ? patch.keywords : current.keywords),
        has("boundTaskId") ? patch.boundTaskId : current.boundTaskId,
        has("boundSessionId") ? patch.boundSessionId : current.boundSessionId,
        has("repositoryLocator") ? patch.repositoryLocator : current.repositoryLocator,
        has("currentVersion") ? patch.currentVersion : current.currentVersion,
        has("approvedVersion") ? patch.approvedVersion : current.approvedVersion,
        has("status") ? patch.status : current.status,
        patch.updatedAt ?? createdAtFromOrNow(), artifactId
      ]
    );
    this.scheduleSave();
    return this.getArtifact(artifactId);
  }

  upsertArtifactSearchDocument(input) {
    const existing = this.selectOne(
      "SELECT body FROM artifact_search_fts WHERE artifact_id = ? LIMIT 1",
      [input.artifactId]
    );
    this.db.run("DELETE FROM artifact_search_fts WHERE artifact_id = ?", [input.artifactId]);
    this.db.run(
      `INSERT INTO artifact_search_fts (
        artifact_id, work_id, title, summary, kind, category_path,
        tags, aliases, keywords, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId, input.workId, input.title ?? "", input.summary ?? "",
        input.kind ?? "other", input.categoryPath ?? "",
        (input.tags ?? []).join(" "), (input.aliases ?? []).join(" "),
        (input.keywords ?? []).join(" "), input.body == null ? (existing?.body ?? "") : input.body
      ]
    );
  }

  searchArtifactDocuments(workId, query, limit = 50) {
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const normalized = String(query ?? "").trim();
    if (!normalized) return [];
    const terms = normalized.split(/\s+/u).filter(Boolean)
      .map((term) => `"${term.replaceAll('"', '""')}"`);
    let ranked = [];
    if (terms.length > 0) {
      try {
        ranked = this.selectAll(
          `SELECT artifact_id, bm25(artifact_search_fts, 0, 0, 10, 6, 4, 4, 5, 7, 5, 1) AS score
           FROM artifact_search_fts
           WHERE (? IS NULL OR work_id = ?) AND artifact_search_fts MATCH ?
           ORDER BY score ASC LIMIT ?`,
          [workId, workId, terms.join(" OR "), boundedLimit]
        );
      } catch {
        ranked = [];
      }
    }
    const seen = new Set(ranked.map((row) => row.artifact_id));
    const fallback = this.selectAll(
      `SELECT artifact_id, 1000 AS score FROM artifact_search_fts
       WHERE (? IS NULL OR work_id = ?) AND LOWER(
         title || ' ' || summary || ' ' || kind || ' ' || category_path || ' '
         || tags || ' ' || aliases || ' ' || keywords || ' ' || body
       ) LIKE LOWER(?) LIMIT ?`,
      [workId, workId, `%${normalized}%`, boundedLimit]
    ).filter((row) => !seen.has(row.artifact_id));
    return [...ranked, ...fallback].slice(0, boundedLimit).map((row) => ({
      artifactId: row.artifact_id,
      score: Number(row.score)
    }));
  }

  createArtifactVersion(input) {
    this.db.run(
      `INSERT INTO artifact_versions (
         artifact_id, version, content_hash, byte_length, mime_type, storage_key,
         source_session_id, source_event_id, supersedes_version, approval_status,
         created_by_actor_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId, input.version, input.contentHash, input.byteLength, input.mimeType,
        input.storageKey ?? null, input.sourceSessionId ?? null, input.sourceEventId ?? null,
        input.supersedesVersion ?? null, input.approvalStatus, input.actorId, input.createdAt
      ]
    );
    this.scheduleSave();
    return this.getArtifactVersion(input.artifactId, input.version);
  }

  getArtifactVersion(artifactId, version) {
    const row = this.selectOne(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`,
      [artifactId, version]
    );
    return row ? artifactVersionFromRow(row) : null;
  }

  listArtifactVersions(artifactId) {
    return this.selectAll(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`,
      [artifactId]
    ).map(artifactVersionFromRow);
  }

  createArtifactReference(input) {
    this.db.run(
      `INSERT INTO artifact_references (
         reference_id, artifact_id, work_id, task_id, session_id, relation, required,
         version_policy, pinned_version, pinned_hash, authorized_by_actor_id, authorized_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.referenceId, input.artifactId, input.workId, input.taskId ?? null,
        input.sessionId ?? null, input.relation, input.required, input.versionPolicy,
        input.pinnedVersion, input.pinnedHash, input.actorId, input.authorizedAt
      ]
    );
    this.scheduleSave();
    return this.getArtifactReference(input.referenceId);
  }

  getArtifactWorkerCreateOperation(sessionId, idempotencyKey) {
    return this.selectOne(
      `SELECT * FROM artifact_worker_create_operations WHERE session_id = ? AND idempotency_key = ?`,
      [sessionId, idempotencyKey]
    );
  }

  createArtifactWorkerCreateOperation(input) {
    this.db.run(
      `INSERT INTO artifact_worker_create_operations (
         session_id, work_id, task_id, idempotency_key, request_fingerprint,
         artifact_id, reference_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId, input.workId, input.taskId, input.idempotencyKey,
        input.requestFingerprint, input.artifactId, input.referenceId, input.createdAt
      ]
    );
    return this.getArtifactWorkerCreateOperation(input.sessionId, input.idempotencyKey);
  }

  getArtifactWorkerPublishOperation(actorScopeId, idempotencyKey) {
    return this.selectOne(
      `SELECT * FROM artifact_worker_publish_operations
       WHERE actor_scope_id = ? AND idempotency_key = ?`,
      [actorScopeId, idempotencyKey]
    );
  }

  createArtifactWorkerPublishOperation(input) {
    this.db.run(
      `INSERT INTO artifact_worker_publish_operations (
         actor_scope_id, work_id, task_id, idempotency_key, request_fingerprint,
         artifact_id, reference_id, version, content_hash, operation_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.actorScopeId, input.workId, input.taskId, input.idempotencyKey,
        input.requestFingerprint, input.artifactId, input.referenceId, input.version,
        input.contentHash, input.operationStatus ?? "completed", input.createdAt
      ]
    );
    return this.getArtifactWorkerPublishOperation(input.actorScopeId, input.idempotencyKey);
  }

  getArtifactReference(referenceId) {
    const row = this.selectOne(`SELECT * FROM artifact_references WHERE reference_id = ?`, [referenceId]);
    return row ? artifactReferenceFromRow(row) : null;
  }

  listArtifactReferences({ artifactId = null, taskId = null, sessionId = null, includeRevoked = false } = {}) {
    const clauses = [];
    const params = [];
    if (artifactId) { clauses.push("artifact_id = ?"); params.push(artifactId); }
    if (taskId) { clauses.push("task_id = ?"); params.push(taskId); }
    if (sessionId) { clauses.push("session_id = ?"); params.push(sessionId); }
    if (!includeRevoked) clauses.push("revoked_at IS NULL");
    return this.selectAll(
      `SELECT * FROM artifact_references ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY required DESC, authorized_at DESC`,
      params
    ).map(artifactReferenceFromRow);
  }

  createTaskFileReference(input) {
    this.db.run(
      `INSERT INTO task_file_references (
         reference_id, work_id, task_id, canonical_path, workspace_root,
         display_name, relation, required, byte_length, modified_at,
         authorized_by_actor_id, authorized_by_session_id, authorized_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.referenceId, input.workId, input.taskId, input.canonicalPath,
        input.workspaceRoot, input.displayName, input.relation, input.required,
        input.byteLength, input.modifiedAt, input.actorId, input.sessionId, input.authorizedAt
      ]
    );
    return this.getTaskFileReference(input.referenceId);
  }

  getTaskFileReference(referenceId) {
    const row = this.selectOne(
      "SELECT * FROM task_file_references WHERE reference_id = ?",
      [referenceId]
    );
    return row ? taskFileReferenceFromRow(row) : null;
  }

  listTaskFileReferences(taskId) {
    return this.selectAll(
      `SELECT * FROM task_file_references WHERE task_id = ?
       ORDER BY required DESC, authorized_at DESC`,
      [taskId]
    ).map(taskFileReferenceFromRow);
  }

  updateArtifactReference(referenceId, patch = {}) {
    const current = this.getArtifactReference(referenceId);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE artifact_references SET pinned_version=?, pinned_hash=?, pending_version=?, pending_hash=?,
       revoked_at=?, revoked_by_actor_id=?, revocation_reason=?, resource_version=resource_version+1
       WHERE reference_id=?`,
      [
        has("pinnedVersion") ? patch.pinnedVersion : current.pinnedVersion,
        has("pinnedHash") ? patch.pinnedHash : current.pinnedHash,
        has("pendingVersion") ? patch.pendingVersion : current.pendingVersion,
        has("pendingHash") ? patch.pendingHash : current.pendingHash,
        has("revokedAt") ? patch.revokedAt : current.revokedAt,
        has("revokedByActorId") ? patch.revokedByActorId : current.revokedByActorId,
        has("revocationReason") ? patch.revocationReason : current.revocationReason,
        referenceId
      ]
    );
    this.scheduleSave();
    return this.getArtifactReference(referenceId);
  }

  appendArtifactAudit(input) {
    this.db.run(
      `INSERT INTO artifact_audit_events (
         audit_id, artifact_id, work_id, action, actor_id, session_id, task_id,
         from_version, to_version, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.auditId, input.artifactId ?? null, input.workId, input.action, input.actorId,
        input.sessionId ?? null, input.taskId ?? null, input.fromVersion ?? null,
        input.toVersion ?? null, JSON.stringify(input.details ?? {}), input.createdAt
      ]
    );
  }

  listArtifactAudit(workId, artifactId = null) {
    return this.selectAll(
      `SELECT * FROM artifact_audit_events WHERE work_id IS ? ${artifactId ? "AND artifact_id = ?" : ""}
       ORDER BY created_at DESC`,
      artifactId ? [workId, artifactId] : [workId]
    ).map(artifactAuditFromRow);
  }

  createArtifactContentOperation(input) {
    this.db.run(
      `INSERT INTO artifact_content_operations (
         operation_id, artifact_id, version, content_hash, temp_path, final_path, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      [input.operationId, input.artifactId, input.version, input.contentHash, input.tempPath,
        input.finalPath, input.createdAt, input.createdAt]
    );
  }

  updateArtifactContentOperation(operationId, status, errorCode = null) {
    this.db.run(
      `UPDATE artifact_content_operations SET status=?, error_code=?, updated_at=? WHERE operation_id=?`,
      [status, errorCode, createdAtFromOrNow(), operationId]
    );
  }

  listIncompleteArtifactContentOperations() {
    return this.selectAll(
      `SELECT * FROM artifact_content_operations WHERE status IN ('prepared', 'file_committed') ORDER BY created_at`
    );
  }

  recordArtifactUsage(input) {
    this.db.run(
      `INSERT INTO artifact_usage_events (
         usage_id, artifact_id, version, content_hash, actor_id, session_id, task_id,
         operation, byte_offset, byte_length, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.usageId, input.artifactId, input.version, input.contentHash, input.actorId,
        input.sessionId, input.taskId ?? null, input.operation, input.byteOffset ?? 0,
        input.byteLength ?? 0, input.createdAt]
    );
  }

  getArtifactTurnReadUsage(logicalSessionId, providerBindingId, turnExecutionId) {
    const row = this.selectOne(
      `SELECT * FROM artifact_turn_read_usage
       WHERE logical_session_id=? AND provider_binding_id=? AND turn_execution_id=?`,
      [logicalSessionId, providerBindingId, turnExecutionId]
    );
    return row ? {
      logicalSessionId: row.logical_session_id,
      providerBindingId: row.provider_binding_id,
      turnExecutionId: row.turn_execution_id,
      uniqueBytes: Number(row.unique_bytes),
      uniquePages: Number(row.unique_pages),
      resourceVersion: Number(row.resource_version),
      updatedAt: row.updated_at
    } : null;
  }

  reserveArtifactTurnRead(input) {
    const current = this.getArtifactTurnReadUsage(
      input.logicalSessionId, input.providerBindingId, input.turnExecutionId
    );
    const uniqueBytes = (current?.uniqueBytes ?? 0) + input.byteLength;
    const uniquePages = (current?.uniquePages ?? 0) + 1;
    if (uniqueBytes > input.uniqueBytesLimit || uniquePages > input.uniquePagesLimit) return null;
    if (current) {
      this.db.run(
        `UPDATE artifact_turn_read_usage
         SET unique_bytes=?, unique_pages=?, resource_version=resource_version+1, updated_at=?
         WHERE logical_session_id=? AND provider_binding_id=? AND turn_execution_id=? AND resource_version=?`,
        [uniqueBytes, uniquePages, input.updatedAt, input.logicalSessionId, input.providerBindingId,
          input.turnExecutionId, current.resourceVersion]
      );
      if (this.db.getRowsModified() !== 1) return null;
    } else {
      this.db.run(
        `INSERT INTO artifact_turn_read_usage (
           logical_session_id, provider_binding_id, turn_execution_id,
           unique_bytes, unique_pages, resource_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [input.logicalSessionId, input.providerBindingId, input.turnExecutionId,
          uniqueBytes, uniquePages, input.updatedAt]
      );
    }
    this.scheduleSave();
    return this.getArtifactTurnReadUsage(input.logicalSessionId, input.providerBindingId, input.turnExecutionId);
  }

  adjustArtifactTurnReadReservation(input) {
    const current = this.getArtifactTurnReadUsage(
      input.logicalSessionId, input.providerBindingId, input.turnExecutionId
    );
    if (!current) return null;
    const uniqueBytes = Math.max(0, current.uniqueBytes + input.byteDelta);
    const uniquePages = Math.max(0, current.uniquePages + input.pageDelta);
    this.db.run(
      `UPDATE artifact_turn_read_usage
       SET unique_bytes=?, unique_pages=?, resource_version=resource_version+1, updated_at=?
       WHERE logical_session_id=? AND provider_binding_id=? AND turn_execution_id=?`,
      [uniqueBytes, uniquePages, input.updatedAt, input.logicalSessionId,
        input.providerBindingId, input.turnExecutionId]
    );
    this.scheduleSave();
    return this.getArtifactTurnReadUsage(input.logicalSessionId, input.providerBindingId, input.turnExecutionId);
  }

  createArtifactReadReceipt(input) {
    this.db.run(
      `INSERT OR IGNORE INTO artifact_read_receipts (
         read_receipt_id, logical_session_id, provider_binding_id, turn_execution_id,
         artifact_id, version, content_hash, byte_offset, byte_length, format,
         reference_id, authorization_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.readReceiptId, input.logicalSessionId, input.providerBindingId, input.turnExecutionId,
        input.artifactId, input.version, input.contentHash, input.byteOffset, input.byteLength,
        input.format, input.referenceId, input.authorizationRevision, input.createdAt]
    );
    const row = this.selectOne(
      "SELECT * FROM artifact_read_receipts WHERE read_receipt_id=?",
      [input.readReceiptId]
    );
    this.scheduleSave();
    return artifactReadReceiptFromRow(row);
  }

  getArtifactReadReceipt(readReceiptId) {
    return artifactReadReceiptFromRow(this.selectOne(
      "SELECT * FROM artifact_read_receipts WHERE read_receipt_id=?",
      [readReceiptId]
    ));
  }

  hasArtifactTextReadBoundary(input) {
    if (input.offset === 0) return true;
    return Boolean(this.selectOne(
      `SELECT 1 FROM artifact_read_receipts
       WHERE logical_session_id=? AND provider_binding_id=? AND turn_execution_id=?
         AND artifact_id=? AND version=? AND content_hash=?
         AND reference_id=? AND authorization_revision=?
         AND format='text' AND byte_offset + byte_length = ? LIMIT 1`,
      [input.logicalSessionId, input.providerBindingId, input.turnExecutionId,
        input.artifactId, input.version, input.contentHash,
        input.referenceId, input.authorizationRevision, input.offset]
    ));
  }

  reconcileArtifactTurnReadUsage(updatedAt = createdAtFromOrNow()) {
    this.db.run(
      `UPDATE artifact_turn_read_usage
       SET unique_bytes=COALESCE((
             SELECT SUM(byte_length) FROM artifact_read_receipts receipt
             WHERE receipt.logical_session_id=artifact_turn_read_usage.logical_session_id
               AND receipt.provider_binding_id=artifact_turn_read_usage.provider_binding_id
               AND receipt.turn_execution_id=artifact_turn_read_usage.turn_execution_id
           ), 0),
           unique_pages=COALESCE((
             SELECT COUNT(*) FROM artifact_read_receipts receipt
             WHERE receipt.logical_session_id=artifact_turn_read_usage.logical_session_id
               AND receipt.provider_binding_id=artifact_turn_read_usage.provider_binding_id
               AND receipt.turn_execution_id=artifact_turn_read_usage.turn_execution_id
           ), 0),
           resource_version=resource_version+1,
           updated_at=?`,
      [updatedAt]
    );
    this.scheduleSave();
    return Number(this.db.getRowsModified());
  }

  appendArtifactStorageAudit(input) {
    this.db.run(
      `INSERT OR IGNORE INTO artifact_storage_audit_events (
         audit_id, action, storage_key, content_hash, byte_length, details_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.auditId, input.action, input.storageKey, input.contentHash, input.byteLength,
        JSON.stringify(input.details ?? {}), input.createdAt]
    );
  }

  listArtifactStorageAudit() {
    return this.selectAll(
      `SELECT * FROM artifact_storage_audit_events ORDER BY created_at DESC`
    ).map((row) => ({
      auditId: row.audit_id,
      action: row.action,
      storageKey: row.storage_key,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at
    }));
  }
}

function artifactFromRow(row) {
  return {
    artifactId: row.artifact_id,
    workId: row.work_id,
    title: row.title,
    summary: row.summary ?? "",
    visibility: row.visibility,
    scope: row.scope ?? artifactScopeForVisibility(row.visibility),
    kind: row.kind ?? "other",
    categoryPath: row.category_path ?? "",
    tags: parseJson(row.tags_json, []),
    aliases: parseJson(row.aliases_json, []),
    keywords: parseJson(row.keywords_json, []),
    boundTaskId: row.bound_task_id ?? null,
    boundSessionId: row.bound_session_id ?? null,
    repositoryLocator: row.repository_locator ?? null,
    currentVersion: Number(row.current_version ?? 0),
    approvedVersion: row.approved_version == null ? null : Number(row.approved_version),
    status: row.status,
    sourceSessionId: row.source_session_id ?? null,
    sourceEventId: row.source_event_id ?? null,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resourceVersion: Number(row.resource_version ?? 1)
  };
}

function artifactScopeForVisibility(visibility) {
  if (visibility === "task_private") return "task";
  if (visibility === "session_private") return "session";
  return "work";
}

function artifactVersionFromRow(row) {
  return {
    artifactId: row.artifact_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length),
    mimeType: row.mime_type,
    storageKey: row.storage_key ?? null,
    sourceSessionId: row.source_session_id ?? null,
    sourceEventId: row.source_event_id ?? null,
    supersedesVersion: row.supersedes_version == null ? null : Number(row.supersedes_version),
    approvalStatus: row.approval_status,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at
  };
}

function artifactReferenceFromRow(row) {
  return {
    referenceId: row.reference_id,
    artifactId: row.artifact_id,
    workId: row.work_id,
    taskId: row.task_id ?? null,
    sessionId: row.session_id ?? null,
    relation: row.relation,
    required: Boolean(row.required),
    versionPolicy: row.version_policy,
    pinnedVersion: Number(row.pinned_version),
    pinnedHash: row.pinned_hash,
    pendingVersion: row.pending_version == null ? null : Number(row.pending_version),
    pendingHash: row.pending_hash ?? null,
    authorizedByActorId: row.authorized_by_actor_id,
    authorizedAt: row.authorized_at,
    revokedAt: row.revoked_at ?? null,
    revokedByActorId: row.revoked_by_actor_id ?? null,
    revocationReason: row.revocation_reason ?? null,
    resourceVersion: Number(row.resource_version ?? 1)
  };
}

function taskFileReferenceFromRow(row) {
  return {
    referenceId: row.reference_id,
    workId: row.work_id,
    taskId: row.task_id,
    path: row.canonical_path,
    workspaceRoot: row.workspace_root,
    displayName: row.display_name,
    relation: row.relation,
    required: Boolean(row.required),
    byteLength: Number(row.byte_length),
    modifiedAt: row.modified_at,
    authorizedByActorId: row.authorized_by_actor_id,
    authorizedBySessionId: row.authorized_by_session_id,
    authorizedAt: row.authorized_at
  };
}

function artifactAuditFromRow(row) {
  return {
    auditId: row.audit_id,
    artifactId: row.artifact_id ?? null,
    workId: row.work_id,
    action: row.action,
    actorId: row.actor_id,
    sessionId: row.session_id ?? null,
    taskId: row.task_id ?? null,
    fromVersion: row.from_version == null ? null : Number(row.from_version),
    toVersion: row.to_version == null ? null : Number(row.to_version),
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at
  };
}

function artifactReadReceiptFromRow(row) {
  if (!row) return null;
  return {
    readReceiptId: row.read_receipt_id,
    logicalSessionId: row.logical_session_id,
    providerBindingId: row.provider_binding_id,
    turnExecutionId: row.turn_execution_id,
    artifactId: row.artifact_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    byteOffset: Number(row.byte_offset),
    byteLength: Number(row.byte_length),
    format: row.format,
    referenceId: row.reference_id,
    authorizationRevision: row.authorization_revision,
    createdAt: row.created_at
  };
}
