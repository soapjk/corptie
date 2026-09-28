import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

export class CollaborationDirectoryRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  upsertCollaborator(entry) {
    this.db.run(
      `INSERT INTO collaborator_registry (
        entry_type, entry_id, role, capability_tags_json, description, availability,
        trust_score, policy_json, endpoint_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_type, entry_id) DO UPDATE SET
        role=excluded.role,
        capability_tags_json=excluded.capability_tags_json,
        description=excluded.description,
        availability=excluded.availability,
        trust_score=excluded.trust_score,
        policy_json=excluded.policy_json,
        endpoint_json=excluded.endpoint_json,
        updated_at=excluded.updated_at`,
      [
        entry.entryType,
        entry.entryId,
        entry.role ?? "agent",
        JSON.stringify(entry.capabilityTags ?? []),
        entry.description ?? "",
        entry.availability ?? "idle",
        entry.trustScore ?? 0.5,
        JSON.stringify(entry.policy ?? {}),
        JSON.stringify(entry.endpoint ?? {}),
        createdAtFromOrNow()
      ]
    );
    this.scheduleSave();
    return this.getCollaborator(entry.entryType, entry.entryId);
  }

  getCollaborator(entryType, entryId) {
    return this.selectOne(
      `SELECT * FROM collaborator_registry WHERE entry_type = ? AND entry_id = ?`,
      [entryType, entryId]
    );
  }

  listCollaborators(entryType = "agent") {
    return this.selectAll(
      `SELECT * FROM collaborator_registry WHERE entry_type = ?`,
      [entryType]
    );
  }

  removeCollaborator(entryType, entryId) {
    this.db.run(
      `DELETE FROM collaborator_registry WHERE entry_type = ? AND entry_id = ?`,
      [entryType, entryId]
    );
    this.scheduleSave();
  }

  createCollaborationSession(input = {}) {
    const id = input.id ?? `collab:${randomUUID()}`;
    this.db.run(
      `INSERT INTO collaboration_sessions (
        id, requester_session_id, requester_work_id, requester_task_id,
        mode, request_json, candidate_entry_type, candidate_entry_id,
        status, result_json, created_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.requesterSessionId ?? null,
        input.requesterWorkId ?? null,
        input.requesterTaskId ?? null,
        input.mode,
        JSON.stringify(input.request ?? {}),
        input.candidateEntryType ?? null,
        input.candidateEntryId ?? null,
        input.status ?? "proposed",
        JSON.stringify(input.result ?? {}),
        createdAtFromOrNow(),
        input.closedAt ?? null
      ]
    );
    this.scheduleSave();
    return this.getCollaborationSession(id);
  }

  getCollaborationSession(id) {
    return this.selectOne(`SELECT * FROM collaboration_sessions WHERE id = ?`, [id]);
  }

  updateCollaborationSession(id, patch = {}) {
    const current = this.getCollaborationSession(id);
    if (!current) return null;
    this.db.run(
      `UPDATE collaboration_sessions SET
        status=?, candidate_entry_type=?, candidate_entry_id=?, result_json=?, closed_at=?
       WHERE id=?`,
      [
        patch.status ?? current.status,
        patch.candidateEntryType ?? current.candidate_entry_type,
        patch.candidateEntryId ?? current.candidate_entry_id,
        JSON.stringify(patch.result ?? JSON.parse(current.result_json || "{}")),
        patch.closedAt ?? current.closed_at,
        id
      ]
    );
    this.scheduleSave();
    return this.getCollaborationSession(id);
  }

  upsertReputation(entryId, trustScore, sampleCount = 1) {
    this.db.run(
      `INSERT INTO collab_reputation_cache (entry_id, trust_score, sample_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         trust_score=excluded.trust_score,
         sample_count=excluded.sample_count,
         updated_at=excluded.updated_at`,
      [entryId, trustScore, sampleCount, createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  getReputation(entryId) {
    return this.selectOne(
      `SELECT * FROM collab_reputation_cache WHERE entry_id = ?`,
      [entryId]
    );
  }

  // 当前在跑的协作数（load_penalty 用，14.6）：status 非 closed 的协作会话数。
  countActiveCollaborations(entryId) {
    const row = this.selectOne(
      `SELECT COUNT(*) AS n FROM collaboration_sessions
        WHERE candidate_entry_id = ? AND status != 'closed'`,
      [entryId]
    );
    return row ? Number(row.n) : 0;
  }
}
