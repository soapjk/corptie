import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

// Uses the Store-owned connection; owns no database lifecycle.
export class SessionCapabilityRepository {
  constructor({ getDatabase, selectOne, selectAll, getSession, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.getSession = getSession;
    this.scheduleSave = scheduleSave;
  }

  get db() { return this.getDatabase(); }

  grantSessionCapability(sessionId, capability, grantedBySessionId = null) {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    const normalized = String(capability ?? "").trim();
    if (!normalized) throw new TypeError("Session capability is required.");
    this.db.run(
      `INSERT INTO session_capability_grants (
         session_id, capability, granted_at, granted_by_session_id, revoked_at
       ) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(session_id, capability) DO UPDATE SET
         granted_at=excluded.granted_at,
         granted_by_session_id=excluded.granted_by_session_id,
         revoked_at=NULL`,
      [sessionId, normalized, createdAtFromOrNow(), grantedBySessionId]
    );
    this.scheduleSave();
    return this.listSessionCapabilities(sessionId);
  }

  revokeSessionCapability(sessionId, capability) {
    this.db.run(
      `UPDATE session_capability_grants SET revoked_at = ?
       WHERE session_id = ? AND capability = ? AND revoked_at IS NULL`,
      [createdAtFromOrNow(), sessionId, String(capability ?? "").trim()]
    );
    this.scheduleSave();
    return this.listSessionCapabilities(sessionId);
  }

  sessionHasCapability(sessionId, capability) {
    return Boolean(this.selectOne(
      `SELECT 1 FROM session_capability_grants
       WHERE session_id = ? AND capability = ? AND revoked_at IS NULL`,
      [sessionId, String(capability ?? "").trim()]
    ));
  }

  listSessionCapabilities(sessionId) {
    return this.selectAll(
      `SELECT capability FROM session_capability_grants
       WHERE session_id = ? AND revoked_at IS NULL ORDER BY capability ASC`,
      [sessionId]
    ).map((row) => row.capability);
  }
}
