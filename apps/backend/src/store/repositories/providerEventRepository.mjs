import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";

// Ingestion owns the atomic inbox/projection/outbox transaction through the Store.
export class ProviderEventRepository {
  constructor({ getDatabase, selectAll, selectOne }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
  }

  get db() {
    return this.getDatabase();
  }

  providerInboxEvent(providerId, providerSessionId, providerEventId) {
    return this.selectOne(
      `SELECT * FROM provider_event_inbox
       WHERE provider_id = ? AND provider_session_id = ? AND provider_event_id = ?`,
      [providerId, providerSessionId, providerEventId]
    );
  }

  insertProviderInboxEvent(event, sessionId = null, eventFingerprint = null) {
    this.db.run(
      `INSERT OR IGNORE INTO provider_event_inbox (
        provider_id, provider_session_id, provider_event_id, binding_id,
        logical_session_id, session_id, routing_version, provider_sequence,
        turn_id, item_id, event_type, occurred_at, received_at,
        raw_payload_json, normalized_event_json, event_fingerprint, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
      [
        event.providerId,
        event.providerSessionId,
        event.providerEventId,
        event.bindingId,
        event.logicalSessionId ?? null,
        sessionId,
        event.routingVersion,
        event.providerSequence ?? null,
        event.turnId ?? null,
        event.itemId ?? null,
        event.type,
        event.occurredAt ?? null,
        event.receivedAt,
        JSON.stringify(event.rawPayload ?? event.payload ?? {}),
        JSON.stringify(event),
        eventFingerprint,
      ]
    );
    return this.db.getRowsModified() > 0;
  }

  markProviderInboxEvent(providerId, providerSessionId, providerEventId, {
    status,
    failureCode = null,
    failureMessage = null,
    appliedAt = null
  }) {
    this.db.run(
      `UPDATE provider_event_inbox
       SET status = ?, failure_code = ?, failure_message = ?, applied_at = ?,
           raw_payload_json = CASE
             WHEN ? = 'applied' AND event_fingerprint IS NOT NULL THEN '{}'
             ELSE raw_payload_json
           END,
           normalized_event_json = CASE
             WHEN ? = 'applied' AND event_fingerprint IS NOT NULL THEN '{}'
             ELSE normalized_event_json
           END
       WHERE provider_id = ? AND provider_session_id = ? AND provider_event_id = ?`,
      [
        status, failureCode, failureMessage, appliedAt, status, status,
        providerId, providerSessionId, providerEventId
      ]
    );
  }

  providerBindingCursor(bindingId) {
    return this.selectOne(
      "SELECT * FROM provider_binding_cursors WHERE binding_id = ?",
      [bindingId]
    );
  }

  markProviderBindingCursorDegraded(binding, updatedAt = createdAtFromOrNow()) {
    this.db.run(
      `INSERT INTO provider_binding_cursors (
        binding_id, provider_id, provider_session_id, routing_version,
        sync_health, updated_at
      ) VALUES (?, ?, ?, ?, 'degraded', ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        sync_health='degraded', updated_at=excluded.updated_at`,
      [
        binding.bindingId,
        binding.providerId,
        binding.providerSessionId,
        binding.routingVersion,
        updatedAt
      ]
    );
  }

  upsertProviderBindingCursor(event, {
    syncHealth = "healthy",
    connectionStatus = "connected",
    gapExpectedSequence = null,
    gapReceivedSequence = null,
    resumeToken = null,
    cursorSequence = event.providerSequence ?? null,
    cursorEventId = event.providerEventId
  } = {}) {
    const timestamp = event.receivedAt ?? createdAtFromOrNow();
    this.db.run(
      `INSERT INTO provider_binding_cursors (
        binding_id, provider_id, provider_session_id, routing_version,
        last_provider_sequence, last_provider_event_id, resume_token,
        connection_status, sync_health, gap_expected_sequence, gap_received_sequence,
        last_connected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        provider_id=excluded.provider_id,
        provider_session_id=excluded.provider_session_id,
        routing_version=excluded.routing_version,
        last_provider_sequence=COALESCE(excluded.last_provider_sequence, provider_binding_cursors.last_provider_sequence),
        last_provider_event_id=COALESCE(excluded.last_provider_event_id, provider_binding_cursors.last_provider_event_id),
        resume_token=COALESCE(excluded.resume_token, provider_binding_cursors.resume_token),
        connection_status=excluded.connection_status,
        sync_health=excluded.sync_health,
        gap_expected_sequence=excluded.gap_expected_sequence,
        gap_received_sequence=excluded.gap_received_sequence,
        last_connected_at=excluded.last_connected_at,
        updated_at=excluded.updated_at`,
      [
        event.bindingId,
        event.providerId,
        event.providerSessionId,
        event.routingVersion,
        cursorSequence,
        cursorEventId,
        resumeToken,
        connectionStatus,
        syncHealth,
        gapExpectedSequence,
        gapReceivedSequence,
        timestamp,
        timestamp
      ]
    );
  }

  upsertSessionTurn({
    sessionId,
    bindingId,
    routingVersion,
    turnId,
    executionStatus,
    finalItemId = null,
    startedAt = null,
    endedAt = null,
    providerSequence = null,
    failure = null,
    syncHealth = "healthy",
    updatedAt = null
  }) {
    const timestamp = updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `INSERT INTO session_turns (
        session_id, binding_id, routing_version, turn_id, execution_status,
        final_item_id, started_at, ended_at, last_provider_sequence,
        failure_json, sync_health, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, binding_id, turn_id) DO UPDATE SET
        routing_version=excluded.routing_version,
        execution_status=CASE
          WHEN session_turns.execution_status IN ('completed', 'failed', 'cancelled') THEN session_turns.execution_status
          ELSE excluded.execution_status
        END,
        final_item_id=COALESCE(excluded.final_item_id, session_turns.final_item_id),
        started_at=COALESCE(session_turns.started_at, excluded.started_at),
        ended_at=CASE
          WHEN session_turns.execution_status IN ('completed', 'failed', 'cancelled') THEN session_turns.ended_at
          ELSE COALESCE(excluded.ended_at, session_turns.ended_at)
        END,
        last_provider_sequence=COALESCE(excluded.last_provider_sequence, session_turns.last_provider_sequence),
        failure_json=CASE
          WHEN session_turns.execution_status IN ('completed', 'failed', 'cancelled') THEN session_turns.failure_json
          ELSE excluded.failure_json
        END,
        sync_health=excluded.sync_health,
        updated_at=excluded.updated_at`,
      [
        sessionId,
        bindingId,
        routingVersion,
        turnId,
        executionStatus,
        finalItemId,
        startedAt,
        endedAt,
        providerSequence,
        failure == null ? null : JSON.stringify(failure),
        syncHealth,
        timestamp
      ]
    );
  }

  getSessionTurn(sessionId, bindingId, turnId) {
    return this.selectOne(
      `SELECT * FROM session_turns
       WHERE session_id = ? AND binding_id = ? AND turn_id = ?`,
      [sessionId, bindingId, turnId]
    );
  }

  hasSessionTurnForBinding(sessionId, bindingId) {
    return Boolean(this.selectOne(
      `SELECT 1 AS present FROM session_turns
       WHERE session_id = ? AND binding_id = ? LIMIT 1`,
      [sessionId, bindingId]
    ));
  }

  upsertSessionContextUsage({ sessionId, bindingId = null, routingVersion = null,
    providerId, model = null, context, updatedAt = null }) {
    const timestamp = updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `INSERT INTO session_context_usage_snapshots (
        session_id, binding_id, routing_version, provider_id, model_id, context_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        binding_id=excluded.binding_id,
        routing_version=excluded.routing_version,
        provider_id=excluded.provider_id,
        model_id=excluded.model_id,
        context_json=excluded.context_json,
        updated_at=excluded.updated_at`,
      [sessionId, bindingId, routingVersion, providerId, model,
        JSON.stringify(context), timestamp]
    );
    return this.getSessionContextUsage(sessionId);
  }

  getSessionContextUsage(sessionId) {
    const row = this.selectOne(
      "SELECT * FROM session_context_usage_snapshots WHERE session_id = ?",
      [sessionId]
    );
    if (!row) return null;
    return {
      sessionId: row.session_id,
      bindingId: row.binding_id ?? null,
      routingVersion: row.routing_version ?? null,
      providerId: row.provider_id,
      model: row.model_id ?? null,
      context: parseJson(row.context_json, null),
      updatedAt: row.updated_at
    };
  }

  upsertProviderModelUsage({ providerId, model = null, account, observedAt = null, updatedAt = null }) {
    const timestamp = updatedAt ?? createdAtFromOrNow();
    const observation = observedAt ?? timestamp;
    this.db.run(
      `INSERT INTO provider_model_usage_snapshots (
        provider_id, model_id, account_json, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET
        account_json=excluded.account_json,
        observed_at=excluded.observed_at,
        updated_at=excluded.updated_at`,
      [providerId, model ?? "", JSON.stringify(account), observation, timestamp]
    );
    return this.getProviderModelUsage(providerId, model);
  }

  getProviderModelUsage(providerId, model = null) {
    const row = this.selectOne(
      "SELECT * FROM provider_model_usage_snapshots WHERE provider_id = ? AND model_id = ?",
      [providerId, model ?? ""]
    );
    if (!row) return null;
    return { providerId: row.provider_id, model: row.model_id || null,
      account: parseJson(row.account_json, null), observedAt: row.observed_at, updatedAt: row.updated_at };
  }

  // Compatibility projection for older callers. Account fallback is deliberately
  // resolved by the context's exact provider/model key, never by Session ownership.
  upsertSessionUsageSnapshot({ sessionId, providerId, model = null, context = null,
    account = null, updatedAt = null }) {
    if (context != null) this.upsertSessionContextUsage({
      sessionId, providerId, model, context, updatedAt
    });
    if (account != null) this.upsertProviderModelUsage({
      providerId, model: account.model ?? model, account, updatedAt
    });
    return this.getSessionUsageSnapshot(sessionId);
  }

  getSessionUsageSnapshot(sessionId) {
    const context = this.getSessionContextUsage(sessionId);
    if (!context) return null;
    const providerModel = this.getProviderModelUsage(context.providerId, context.model);
    return { ...context, account: providerModel?.account ?? null };
  }

  listUnsettledSessionTurns(sessionId) {
    return this.selectAll(
      `SELECT * FROM session_turns
       WHERE session_id = ? AND execution_status IN ('running', 'blocked')
       ORDER BY updated_at ASC, binding_id ASC, turn_id ASC`,
      [sessionId]
    );
  }


  latestCompletedSessionTurn(sessionId, bindingId = null) {
    const row = bindingId
      ? this.selectOne(
        `SELECT * FROM session_turns
         WHERE session_id = ? AND binding_id = ? AND execution_status = 'completed'
         ORDER BY COALESCE(ended_at, updated_at) DESC, turn_id DESC LIMIT 1`,
        [sessionId, bindingId]
      )
      : this.selectOne(
        `SELECT * FROM session_turns
         WHERE session_id = ? AND execution_status = 'completed'
         ORDER BY COALESCE(ended_at, updated_at) DESC, turn_id DESC LIMIT 1`,
        [sessionId]
      );
    return row ?? null;
  }

  enqueueEventOutbox({ outboxId, topic, sessionId = null, revision = null, eventType, payload, createdAt }) {
    this.db.run(
      `INSERT INTO event_outbox (
        outbox_id, topic, session_id, revision, event_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [outboxId, topic, sessionId, revision, eventType, JSON.stringify(payload ?? {}), createdAt]
    );
    return this.selectOne("SELECT * FROM event_outbox WHERE outbox_id = ?", [outboxId]);
  }

  listPendingEventOutbox(limit = 200) {
    const pageLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    return this.selectAll(
      `SELECT * FROM event_outbox WHERE status = 'pending'
       ORDER BY created_at ASC, outbox_id ASC LIMIT ?`,
      [pageLimit]
    );
  }

  markEventOutboxPublished(outboxId, publishedAt = createdAtFromOrNow()) {
    this.db.run(
      "DELETE FROM event_outbox WHERE outbox_id = ? AND status = 'pending'",
      [outboxId]
    );
  }
}
