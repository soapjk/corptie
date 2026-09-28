import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { requiredText } from "../validation.mjs";
import { parseJson } from "../storedJson.mjs";
import { recoveryStableJson } from "../recoveryStableJson.mjs";
import { sessionEventFromRow } from "../sessionEventRow.mjs";

export class SessionRecoveryRepository {
  constructor({ getDatabase, selectOne, selectAll, runInTransaction, getLogicalSession, getSession, assertLogicalSessionRoute, assertLogicalWorkSessionBinding, getSessionToolCatalogMaterialization, listArtifactReferences, listSessionContextReferences, scheduleSave, insertAppliedSessionToolCatalogMaterialization }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.selectAll = selectAll;
    this.runInTransaction = runInTransaction;
    this.getLogicalSession = getLogicalSession;
    this.getSession = getSession;
    this.assertLogicalSessionRoute = assertLogicalSessionRoute;
    this.assertLogicalWorkSessionBinding = assertLogicalWorkSessionBinding;
    this.getSessionToolCatalogMaterialization = getSessionToolCatalogMaterialization;
    this.listArtifactReferences = listArtifactReferences;
    this.listSessionContextReferences = listSessionContextReferences;
    this.scheduleSave = scheduleSave;
    this.insertAppliedSessionToolCatalogMaterialization = insertAppliedSessionToolCatalogMaterialization;
  }

  get db() {
    return this.getDatabase();
  }

  getSessionRecoveryAttempt(attemptId) {
    const row = this.selectOne(
      "SELECT * FROM session_recovery_attempts WHERE attempt_id = ?",
      [attemptId]
    );
    return row ? sessionRecoveryAttemptFromRow(row) : null;
  }

  getSessionRecoveryAttemptByIdempotency(logicalSessionId, idempotencyKey) {
    const row = this.selectOne(
      `SELECT * FROM session_recovery_attempts
       WHERE logical_session_id = ? AND idempotency_key = ?`,
      [logicalSessionId, idempotencyKey]
    );
    return row ? sessionRecoveryAttemptFromRow(row) : null;
  }

  listSessionRecoveryAttempts(logicalSessionId, limit = 50) {
    return this.selectAll(
      `SELECT * FROM session_recovery_attempts WHERE logical_session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [logicalSessionId, Math.max(1, Math.min(200, Number(limit) || 50))]
    ).map(sessionRecoveryAttemptFromRow);
  }

  listResumableSessionRecoveryAttempts(limit = 100) {
    return this.selectAll(
      `SELECT * FROM session_recovery_attempts
       WHERE state IN ('frozen','replacement_created','replaying','validated')
         AND cancel_requested=0 ORDER BY created_at LIMIT ?`,
      [Math.max(1, Math.min(500, Number(limit) || 100))]
    ).map(sessionRecoveryAttemptFromRow);
  }

  freezeSessionRecoveryAttempt(input) {
    const logicalSessionId = requiredText(input.logicalSessionId, "logicalSessionId");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const existing = this.getSessionRecoveryAttemptByIdempotency(logicalSessionId, idempotencyKey);
    if (existing) return existing;
    const attemptId = requiredText(input.attemptId, "attemptId");
    const timestamp = input.createdAt ?? createdAtFromOrNow();
    return this.runInTransaction(() => {
      const logical = this.getLogicalSession(logicalSessionId);
      const binding = logical?.activeBinding;
      const session = logical?.legacySessionId ? this.getSession(logical.legacySessionId) : null;
      if (!logical || !binding || !session) {
        const error = new Error("The logical Session has no complete active Provider binding.");
        error.code = "RECOVERY_BINDING_MISSING";
        throw error;
      }
      this.assertLogicalSessionRoute(logicalSessionId);
      const workBinding = this.assertLogicalWorkSessionBinding(logicalSessionId);
      const triggerDeliveryId = input.triggerDeliveryId == null
        ? null
        : requiredText(input.triggerDeliveryId, "triggerDeliveryId");
      const triggerEvent = triggerDeliveryId
        ? this.selectOne(
          `SELECT sequence FROM session_events
           WHERE session_id = ?
             AND type = 'SessionUserMessageCreated'
             AND (
               json_extract(source_json, '$.deliveryId') = ?
               OR json_extract(payload_json, '$.deliveryId') = ?
             )
           ORDER BY sequence DESC LIMIT 1`,
          [session.id, triggerDeliveryId, triggerDeliveryId]
        )
        : null;
      if (triggerDeliveryId && !triggerEvent) {
        const error = new Error("The recovery-triggering Message Delivery is not present in the authoritative Timeline.");
        error.code = "RECOVERY_TRIGGER_DELIVERY_MISSING";
        throw error;
      }
      const boundary = triggerEvent
        ? this.selectOne(
          `SELECT sequence, payload_json FROM session_events
           WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1`,
          [session.id, Number(triggerEvent.sequence)]
        )
        : this.selectOne(
          `SELECT sequence, payload_json FROM session_events
           WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`,
          [session.id]
        );
      const toolCatalog = this.getSessionToolCatalogMaterialization(logicalSessionId, binding.bindingId);
      const artifactReferences = [
        ...this.listArtifactReferences({ sessionId: session.id }),
        ...(session.taskId ? this.listArtifactReferences({ taskId: session.taskId }) : [])
      ].filter((reference, index, all) => all.findIndex((candidate) => candidate.referenceId === reference.referenceId) === index)
        .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
      const boundaryPayload = parseJson(boundary?.payload_json, {});
      const snapshot = {
        attemptId,
        idempotencyKey,
        logicalSessionId,
        sessionId: session.id,
        providerId: binding.providerId,
        sourceBindingId: binding.bindingId,
        sourceProviderSessionId: binding.providerSessionId,
        sourceRoutingVersion: logical.routingVersion,
        sourceBindingGeneration: binding.bindingGeneration,
        targetBindingGeneration: binding.bindingGeneration + 1,
        capabilityRevision: requiredText(input.capabilityRevision, "capabilityRevision"),
        triggerDeliveryId,
        boundarySequence: Number(boundary?.sequence ?? 0),
        boundaryTurnId: boundaryPayload.turnId ?? null,
        repositoryId: logical.repositoryId ?? null,
        workspaceId: logical.activeWorkspaceId ?? null,
        worktreeId: binding.worktreeId ?? null,
        boundCwd: binding.boundCwd,
        workId: workBinding.workId ?? session.workId ?? null,
        taskId: workBinding.taskId ?? session.taskId ?? null,
        instructionSources: binding.instructionSources ?? [],
        permissionSnapshot: binding.permissionSnapshot ?? {},
        toolCatalog: toolCatalog ? {
          desiredVersion: toolCatalog.desiredVersion,
          appliedVersion: toolCatalog.appliedVersion,
          desiredCatalogVersion: toolCatalog.desiredCatalogVersion,
          appliedCatalogVersion: toolCatalog.appliedCatalogVersion,
          desiredDomains: toolCatalog.desiredDomains,
          appliedDomains: toolCatalog.appliedDomains,
          exposurePlan: toolCatalog.exposurePlan,
          providerReceipt: toolCatalog.providerReceipt,
          resourceVersion: toolCatalog.resourceVersion,
          status: toolCatalog.status
        } : {},
        artifactReferences,
        contextReferences: this.listSessionContextReferences(session.id),
        strategy: null,
        manifestHash: null,
        state: "frozen",
        cancelRequested: false,
        replacement: null,
        error: null,
        metrics: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      };
      this.db.run(
        `INSERT INTO session_recovery_attempts (
          attempt_id, logical_session_id, idempotency_key, state, snapshot_json,
          metrics_json, cancel_requested, created_at, updated_at
        ) VALUES (?, ?, ?, 'frozen', ?, '{}', 0, ?, ?)`,
        [attemptId, logicalSessionId, idempotencyKey, JSON.stringify(snapshot), timestamp, timestamp]
      );
      return this.getSessionRecoveryAttempt(attemptId);
    });
  }

  claimSessionRecoveryBoundary(attemptId) {
    const result = this.runInTransaction(() => {
      const attempt = this.getSessionRecoveryAttempt(attemptId);
      if (!attempt) {
        const error = new Error("Session recovery attempt was not found.");
        error.code = "RECOVERY_ATTEMPT_NOT_FOUND";
        throw error;
      }
      if (!["frozen", "replaying", "replacement_created", "validated"].includes(attempt.state)
        || attempt.cancelRequested) {
        const error = new Error("Session recovery attempt is not resumable.");
        error.code = "RECOVERY_ATTEMPT_STATE_INVALID";
        throw error;
      }
      const owner = this.selectOne(
        `SELECT attempt_id FROM session_recovery_attempts
         WHERE logical_session_id=?
           AND state IN ('frozen','replaying','replacement_created','validated')
         ORDER BY created_at ASC, attempt_id ASC LIMIT 1`,
        [attempt.logicalSessionId]
      );
      if (owner?.attempt_id !== attempt.attemptId) {
        const error = new Error("Another Session recovery attempt already owns this route boundary.");
        error.code = "SESSION_BUSY";
        throw error;
      }
      const logical = this.selectOne(
        "SELECT transition_state FROM logical_sessions WHERE logical_session_id=?",
        [attempt.logicalSessionId]
      );
      if (!logical || (logical.transition_state && logical.transition_state !== "sessionRecovery")) {
        const error = new Error("The Session route is already transitioning.");
        error.code = "SESSION_BUSY";
        throw error;
      }
      this.#assertSessionRecoveryDispatchBoundary(attempt);
      const timestamp = createdAtFromOrNow();
      this.db.run(
        `UPDATE logical_sessions SET transition_state='sessionRecovery', updated_at=?
         WHERE logical_session_id=? AND (transition_state IS NULL OR transition_state='sessionRecovery')`,
        [timestamp, attempt.logicalSessionId]
      );
      if (this.db.getRowsModified() !== 1) {
        const error = new Error("The Session route changed before recovery acquired its boundary.");
        error.code = "SESSION_BUSY";
        throw error;
      }
      return this.getSessionRecoveryAttempt(attemptId);
    });
    this.scheduleSave();
    return result;
  }

  retryUnstartedSessionRecoveryAttempt(attemptId) {
    const timestamp = createdAtFromOrNow();
    const result = this.runInTransaction(() => {
      this.db.run(
        `UPDATE session_recovery_attempts
         SET state='frozen', error_code=NULL, error_message=NULL,
             completed_at=NULL, updated_at=?
         WHERE attempt_id=? AND state='failed'
           AND manifest_hash IS NULL AND replacement_json IS NULL
           AND error_code IN ('SESSION_BUSY','RECOVERY_ATTEMPT_STATE_INVALID')`,
        [timestamp, requiredText(attemptId, "attemptId")]
      );
      return this.db.getRowsModified() === 1
        ? this.getSessionRecoveryAttempt(attemptId)
        : null;
    });
    if (result) this.scheduleSave();
    return result;
  }

  #assertSessionRecoveryDispatchBoundary(attempt) {
    const triggerDeliveryId = attempt.triggerDeliveryId ?? null;
    const activeTurn = this.selectOne(
      `SELECT turn_id FROM session_turns
       WHERE session_id=? AND execution_status IN ('running','blocked') LIMIT 1`,
      [attempt.sessionId]
    );
    const activeWork = this.selectOne(
      `SELECT task_id FROM agent_operations
       WHERE session_id=? AND status='running'
         AND NOT (
           ? IS NOT NULL AND target_turn_id IS NULL
           AND (delivery_id=? OR json_extract(source_json, '$.deliveryId')=?)
         )
       LIMIT 1`,
      [attempt.sessionId, triggerDeliveryId, triggerDeliveryId, triggerDeliveryId]
    );
    const activeDelivery = this.selectOne(
      `SELECT delivery_id FROM message_deliveries
       WHERE session_id=?
         AND status IN ('dispatching','accepted','processing')
         AND NOT (
           delivery_id=? AND status='dispatching'
           AND provider_turn_id IS NULL AND provider_acknowledged_at IS NULL
         )
       LIMIT 1`,
      [attempt.sessionId, triggerDeliveryId]
    );
    if (activeTurn || activeWork || activeDelivery) {
      const error = new Error("The Session started Provider work before recovery acquired its route boundary.");
      error.code = "SESSION_BUSY";
      throw error;
    }
  }

  #releaseSessionRecoveryBoundaryIfIdle(logicalSessionId, timestamp) {
    const active = this.selectOne(
      `SELECT attempt_id FROM session_recovery_attempts
       WHERE logical_session_id=?
         AND state IN ('frozen','replaying','replacement_created','validated')
       LIMIT 1`,
      [logicalSessionId]
    );
    if (active) return;
    this.db.run(
      `UPDATE logical_sessions SET transition_state=NULL, updated_at=?
       WHERE logical_session_id=? AND transition_state='sessionRecovery'`,
      [timestamp, logicalSessionId]
    );
  }

  listSessionEventsThrough(sessionId, boundarySequence) {
    const boundary = Number(boundarySequence);
    if (!Number.isSafeInteger(boundary) || boundary < 0) throw new TypeError("boundarySequence must be non-negative.");
    return this.selectAll(
      `SELECT event_id, session_id, log_id, sequence, type, producer, surface,
              source_event_seqs_json, call_id, source_json, payload_json, created_at
       FROM session_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence ASC`,
      [sessionId, boundary]
    ).map(sessionEventFromRow);
  }

  listSessionRecoveryEventSample(sessionId, boundarySequence, options = {}) {
    const boundary = Number(boundarySequence);
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new TypeError("boundarySequence must be non-negative.");
    }
    const headLimit = Math.max(1, Math.min(32, Number(options.headLimit) || 12));
    const tailLimit = Math.max(32, Math.min(400, Number(options.tailLimit) || 240));
    const columns = recoveryEventProjectionSQL("events");
    const predicate = recoveryRelevantEventSQL("events");
    const read = (order, limit) => this.selectAll(
      `SELECT ${columns}
       FROM session_events events
       WHERE events.session_id = ? AND events.sequence <= ?
         AND (${predicate})
       ORDER BY events.sequence ${order}
       LIMIT ?`,
      [sessionId, boundary, limit]
    );
    const head = read("ASC", headLimit);
    const tail = read("DESC", tailLimit).reverse();
    const latestCheckpoint = this.selectOne(
      `SELECT ${columns}
       FROM session_events events
       WHERE events.session_id = ? AND events.sequence <= ?
         AND LOWER(events.type) LIKE '%checkpoint%'
       ORDER BY events.sequence DESC LIMIT 1`,
      [sessionId, boundary]
    );
    const rowsBySequence = new Map();
    for (const row of [...head, ...(latestCheckpoint ? [latestCheckpoint] : []), ...tail]) {
      rowsBySequence.set(Number(row.sequence), row);
    }
    const firstTailSequence = Number(tail[0]?.sequence ?? boundary + 1);
    const lastHeadSequence = Number(head.at(-1)?.sequence ?? 0);
    const truncated = firstTailSequence > lastHeadSequence + 1 && Boolean(this.selectOne(
      `SELECT 1 AS found FROM session_events events
       WHERE events.session_id = ?
         AND events.sequence > ? AND events.sequence < ?
         AND (${predicate})
       LIMIT 1`,
      [sessionId, lastHeadSequence, firstTailSequence]
    ));
    return Object.freeze({
      events: [...rowsBySequence.values()]
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map(sessionEventFromRow),
      truncated
    });
  }

  saveSessionRecoveryManifest(attemptId, manifest, manifestHash) {
    const attempt = this.getSessionRecoveryAttempt(attemptId);
    if (!attempt) return null;
    if (attempt.manifestHash && attempt.manifestHash !== manifestHash) {
      const error = new Error("The recovery idempotency key produced a different ReplayManifest.");
      error.code = "RECOVERY_HASH_MISMATCH";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE session_recovery_attempts SET manifest_json = ?, manifest_hash = ?,
         state = CASE WHEN state='frozen' THEN 'replaying' ELSE state END, updated_at = ?
       WHERE attempt_id = ? AND state IN ('frozen', 'replacement_created', 'replaying')`,
      [JSON.stringify(manifest), manifestHash, timestamp, attemptId]
    );
    this.scheduleSave();
    return this.getSessionRecoveryAttempt(attemptId);
  }

  recordSessionRecoveryReplacement(attemptId, replacement) {
    const attempt = this.getSessionRecoveryAttempt(attemptId);
    if (!attempt) return null;
    if (attempt.replacement
      && recoveryStableJson(attempt.replacement) !== recoveryStableJson(replacement)) {
      const error = new Error("Recovery attempt already owns a different replacement Session.");
      error.code = "RECOVERY_REPLACEMENT_CONFLICT";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE session_recovery_attempts SET replacement_json = ?, state='replacement_created', updated_at=?
       WHERE attempt_id=? AND state IN ('frozen','replaying','replacement_created')`,
      [JSON.stringify(replacement), timestamp, attemptId]
    );
    this.scheduleSave();
    return this.getSessionRecoveryAttempt(attemptId);
  }

  replaceSessionRecoveryReplacement(attemptId, expectedReplacement, replacement) {
    const attempt = this.getSessionRecoveryAttempt(attemptId);
    if (!attempt) return null;
    if (!attempt.replacement
      || recoveryStableJson(attempt.replacement) !== recoveryStableJson(expectedReplacement)) {
      const error = new Error("Recovery replacement changed before its crash-safe journal could be updated.");
      error.code = "RECOVERY_REPLACEMENT_CAS_CONFLICT";
      throw error;
    }
    if (!replacement?.providerSessionId || !replacement?.providerThreadId || !replacement?.bindingId) {
      const error = new Error("Replacement Session identity is incomplete.");
      error.code = "RECOVERY_REPLACEMENT_INVALID";
      throw error;
    }
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `UPDATE session_recovery_attempts SET replacement_json=?, state='replacement_created', updated_at=?
       WHERE attempt_id=? AND replacement_json=? AND state IN ('replaying','replacement_created')`,
      [JSON.stringify(replacement), timestamp, attemptId, JSON.stringify(attempt.replacement)]
    );
    if (this.db.getRowsModified() !== 1) {
      const error = new Error("Recovery replacement lost its compare-and-swap race.");
      error.code = "RECOVERY_REPLACEMENT_CAS_CONFLICT";
      throw error;
    }
    this.scheduleSave();
    return this.getSessionRecoveryAttempt(attemptId);
  }

  requestSessionRecoveryCancellation(attemptId) {
    const timestamp = createdAtFromOrNow();
    const result = this.runInTransaction(() => {
      const attempt = this.getSessionRecoveryAttempt(attemptId);
      if (!attempt) return null;
      this.db.run(
        `UPDATE session_recovery_attempts SET cancel_requested=1, state='cancel_requested', updated_at=?
         WHERE attempt_id=? AND state NOT IN ('committed','cancelled','failed','manual_required')`,
        [timestamp, attemptId]
      );
      this.#releaseSessionRecoveryBoundaryIfIdle(attempt.logicalSessionId, timestamp);
      return this.getSessionRecoveryAttempt(attemptId);
    });
    this.scheduleSave();
    return result;
  }

  cancelSessionRecoveryAttempt(attemptId) {
    const timestamp = createdAtFromOrNow();
    const result = this.runInTransaction(() => {
      const attempt = this.getSessionRecoveryAttempt(attemptId);
      if (!attempt) return null;
      this.db.run(
        `UPDATE session_recovery_attempts SET state='cancelled', cancel_requested=1,
           completed_at=?, updated_at=? WHERE attempt_id=? AND state <> 'committed'`,
        [timestamp, timestamp, attemptId]
      );
      this.#releaseSessionRecoveryBoundaryIfIdle(attempt.logicalSessionId, timestamp);
      return this.getSessionRecoveryAttempt(attemptId);
    });
    this.scheduleSave();
    return result;
  }

  failSessionRecoveryAttempt(attemptId, code, message) {
    const timestamp = createdAtFromOrNow();
    const state = code === "RECOVERY_MANUAL_REQUIRED" ? "manual_required" : "failed";
    const result = this.runInTransaction(() => {
      const attempt = this.getSessionRecoveryAttempt(attemptId);
      if (!attempt) return null;
      this.db.run(
        `UPDATE session_recovery_attempts SET state=?, error_code=?, error_message=?,
           completed_at=?, updated_at=?
         WHERE attempt_id=? AND state NOT IN ('committed','cancelled','manual_required')`,
        [state, requiredText(code, "code"), String(message ?? "Session recovery failed.").slice(0, 500), timestamp, timestamp, attemptId]
      );
      this.#releaseSessionRecoveryBoundaryIfIdle(attempt.logicalSessionId, timestamp);
      return this.getSessionRecoveryAttempt(attemptId);
    });
    this.scheduleSave();
    return result;
  }

  commitSessionRecoveryBinding(input) {
    const attempt = this.getSessionRecoveryAttempt(input.attemptId);
    if (!attempt) {
      const error = new Error("Session recovery attempt was not found.");
      error.code = "RECOVERY_ATTEMPT_NOT_FOUND";
      throw error;
    }
    if (attempt.state === "committed") return attempt;
    if (attempt.cancelRequested) {
      const error = new Error("Session recovery was cancelled before binding commit.");
      error.code = "SESSION_RECOVERY_CANCELLED";
      throw error;
    }
    if (attempt.manifestHash !== input.manifestHash || attempt.capabilityRevision !== input.capabilityRevision) {
      const error = new Error("Recovery Manifest or capability revision changed before binding commit.");
      error.code = "RECOVERY_HASH_MISMATCH";
      throw error;
    }
    const replacement = input.replacement ?? {};
    const providerThreadId = requiredText(replacement.providerThreadId, "replacement.providerThreadId");
    const providerSessionId = requiredText(replacement.providerSessionId, "replacement.providerSessionId");
    const bindingId = requiredText(replacement.bindingId, "replacement.bindingId");
    const timestamp = input.committedAt ?? createdAtFromOrNow();
    this.db.run("BEGIN IMMEDIATE");
    try {
      const currentAttempt = this.getSessionRecoveryAttempt(input.attemptId);
      if (!currentAttempt
        || !["replacement_created", "validated"].includes(currentAttempt.state)
        || currentAttempt.cancelRequested
        || recoveryStableJson(currentAttempt.replacement) !== recoveryStableJson(replacement)) {
        const error = new Error("Recovery replacement changed before binding commit.");
        error.code = "RECOVERY_REPLACEMENT_CAS_CONFLICT";
        throw error;
      }
      const logical = this.selectOne(
        "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
        [attempt.logicalSessionId]
      );
      const oldBinding = this.selectOne(
        "SELECT * FROM provider_thread_bindings WHERE binding_id = ? AND state = 'active'",
        [attempt.sourceBindingId]
      );
      if (!logical || logical.transition_state !== "sessionRecovery" || !oldBinding
        || logical.active_thread_id !== oldBinding.provider_thread_id
        || Number(logical.routing_version) !== Number(input.expectedRoutingVersion)
        || Number(oldBinding.binding_generation) !== Number(input.expectedBindingGeneration)
        || oldBinding.binding_id !== input.expectedSourceBindingId) {
        const error = new Error("The active Provider binding changed before recovery commit.");
        error.code = "RECOVERY_CAS_CONFLICT";
        throw error;
      }
      this.#assertSessionRecoveryDispatchBoundary(currentAttempt);
      const currentArtifacts = [
        ...this.listArtifactReferences({ sessionId: attempt.sessionId }),
        ...(attempt.taskId ? this.listArtifactReferences({ taskId: attempt.taskId }) : [])
      ].filter((reference, index, all) => all.findIndex((candidate) => candidate.referenceId === reference.referenceId) === index)
        .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
      if (recoveryStableJson(currentArtifacts) !== recoveryStableJson(attempt.artifactReferences)) {
        const error = new Error("Artifact References changed after the recovery boundary was frozen.");
        error.code = "RECOVERY_ARTIFACT_REFERENCE_STALE";
        throw error;
      }
      if (recoveryStableJson(this.listSessionContextReferences(attempt.sessionId)) !== recoveryStableJson(attempt.contextReferences)) {
        const error = new Error("Session Context References changed after the recovery boundary was frozen.");
        error.code = "RECOVERY_CONTEXT_REFERENCE_STALE";
        throw error;
      }
      const currentCatalog = this.getSessionToolCatalogMaterialization(attempt.logicalSessionId, attempt.sourceBindingId);
      const catalogSnapshot = currentCatalog ? {
        desiredVersion: currentCatalog.desiredVersion,
        appliedVersion: currentCatalog.appliedVersion,
        desiredCatalogVersion: currentCatalog.desiredCatalogVersion,
        appliedCatalogVersion: currentCatalog.appliedCatalogVersion,
        desiredDomains: currentCatalog.desiredDomains,
        appliedDomains: currentCatalog.appliedDomains,
        exposurePlan: currentCatalog.exposurePlan,
        providerReceipt: currentCatalog.providerReceipt,
        resourceVersion: currentCatalog.resourceVersion,
        status: currentCatalog.status
      } : {};
      if (recoveryStableJson(catalogSnapshot) !== recoveryStableJson(attempt.toolCatalog)) {
        const error = new Error("Tool Host catalog generation changed after the recovery boundary was frozen.");
        error.code = "RECOVERY_CATALOG_STALE";
        throw error;
      }
      this.db.run(
        "UPDATE provider_thread_bindings SET state='superseded', updated_at=? WHERE binding_id=? AND state='active'",
        [timestamp, attempt.sourceBindingId]
      );
      this.db.run(
        `INSERT INTO provider_thread_bindings (
          provider_thread_id, binding_id, provider_id, provider_session_id, logical_session_id,
          worktree_id, bound_cwd, parent_thread_id, parent_binding_id, forked_at_turn_id,
          instruction_sources_json, permission_snapshot_json, provider_metadata_json,
          routing_version, binding_generation, capability_revision, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [providerThreadId, bindingId, attempt.providerId, providerSessionId, attempt.logicalSessionId,
          attempt.worktreeId, attempt.boundCwd, oldBinding.provider_thread_id, attempt.sourceBindingId,
          attempt.boundaryTurnId, JSON.stringify(attempt.instructionSources), JSON.stringify(attempt.permissionSnapshot),
          JSON.stringify({ recoveryAttemptId: attempt.attemptId, replayManifestHash: input.manifestHash }),
          attempt.sourceRoutingVersion + 1, attempt.targetBindingGeneration, input.capabilityRevision, timestamp, timestamp]
      );
      this.insertAppliedSessionToolCatalogMaterialization(input.toolMaterialization, {
        required: attempt.providerId === "codex-app-server" || Boolean(currentCatalog),
        logicalSessionId: attempt.logicalSessionId,
        providerBindingId: bindingId,
        providerId: attempt.providerId,
        providerSessionId,
        providerConfirmation: replacement.toolConfirmation ?? null,
        sourceDesiredDomains: currentCatalog?.desiredDomains ?? [],
        sourceAppliedDomains: currentCatalog?.appliedDomains ?? [],
        createdAt: timestamp
      });
      this.db.run(
        `UPDATE logical_sessions SET active_thread_id=?, routing_version=routing_version+1,
           transition_state=NULL, updated_at=?
         WHERE logical_session_id=? AND active_thread_id=? AND routing_version=?
           AND transition_state='sessionRecovery'`,
        [providerThreadId, timestamp, attempt.logicalSessionId, oldBinding.provider_thread_id, attempt.sourceRoutingVersion]
      );
      if (this.db.getRowsModified() !== 1) {
        const error = new Error("The logical Session route lost its compare-and-swap race.");
        error.code = "RECOVERY_CAS_CONFLICT";
        throw error;
      }
      const storedSessionRow = this.selectOne("SELECT raw_json FROM sessions WHERE id=?", [attempt.sessionId]);
      const storedRaw = parseJson(storedSessionRow?.raw_json, {});
      this.db.run(
        `UPDATE sessions SET raw_json=?, updated_at=? WHERE id=?`,
        [JSON.stringify({
          ...storedRaw,
          provider: attempt.providerId,
          threadId: providerThreadId,
          sessionId: providerSessionId,
          logicalSessionId: attempt.logicalSessionId,
          routingVersion: attempt.sourceRoutingVersion + 1,
          bindingGeneration: attempt.targetBindingGeneration,
          recoveryAttemptId: attempt.attemptId
        }), timestamp, attempt.sessionId]
      );
      this.db.run(
        `INSERT INTO session_recovery_binding_audit (
          audit_id, attempt_id, logical_session_id, old_binding_id, new_binding_id,
          old_provider_session_id, new_provider_session_id, old_routing_version, new_routing_version,
          old_binding_generation, new_binding_generation, capability_revision, manifest_hash, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`session_recovery_audit:${randomUUID()}`, attempt.attemptId, attempt.logicalSessionId,
          attempt.sourceBindingId, bindingId, attempt.sourceProviderSessionId, providerSessionId,
          attempt.sourceRoutingVersion, attempt.sourceRoutingVersion + 1, attempt.sourceBindingGeneration,
          attempt.targetBindingGeneration, input.capabilityRevision, input.manifestHash, timestamp]
      );
      this.db.run(
        `UPDATE session_recovery_attempts SET state='committed', replacement_json=?, metrics_json=?,
           error_code=NULL, error_message=NULL, completed_at=?, updated_at=? WHERE attempt_id=?`,
        [JSON.stringify(replacement), JSON.stringify(input.metrics ?? {}), timestamp, timestamp, attempt.attemptId]
      );
      this.assertLogicalSessionRoute(attempt.logicalSessionId);
      this.assertLogicalWorkSessionBinding(attempt.logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getSessionRecoveryAttempt(attempt.attemptId);
  }

  listSessionRecoveryBindingAudit(logicalSessionId) {
    return this.selectAll(
      `SELECT * FROM session_recovery_binding_audit WHERE logical_session_id=? ORDER BY committed_at`,
      [logicalSessionId]
    );
  }
}

function sessionRecoveryAttemptFromRow(row) {
  const snapshot = parseJson(row.snapshot_json, {});
  return {
    ...snapshot,
    state: row.state,
    strategy: parseJson(row.manifest_json, null)?.strategy ?? snapshot.strategy ?? null,
    manifest: parseJson(row.manifest_json, null),
    manifestHash: row.manifest_hash ?? snapshot.manifestHash ?? null,
    replacement: parseJson(row.replacement_json, snapshot.replacement ?? null),
    metrics: parseJson(row.metrics_json, {}),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function recoveryRelevantEventSQL(tableAlias) {
  return `${tableAlias}.type IN (
      'user/message', 'SessionUserMessageCreated',
      'assistant/message', 'assistant.message.completed',
      'AgentTurnCompleted', 'CodexThreadCompleted', 'turn.completed'
    )
    OR LOWER(${tableAlias}.type) LIKE '%tool.completed%'
    OR LOWER(${tableAlias}.type) LIKE '%tool/result%'
    OR LOWER(${tableAlias}.type) LIKE '%checkpoint%'
    OR LOWER(${tableAlias}.type) LIKE '%context.reference%'
    OR LOWER(${tableAlias}.type) LIKE '%system/context%'
    OR LOWER(${tableAlias}.type) LIKE '%artifact.reference%'
    OR LOWER(${tableAlias}.type) LIKE '%artifact/reference%'`;
}

function recoveryEventProjectionSQL(tableAlias) {
  const completionTurnId = `COALESCE(
    json_extract(${tableAlias}.payload_json, '$.turnId'),
    json_extract(${tableAlias}.payload_json, '$.item.turnId')
  )`;
  const projectedCompletionText = `COALESCE(
    NULLIF(json_extract(${tableAlias}.payload_json, '$.item.text'), ''),
    NULLIF(json_extract(${tableAlias}.payload_json, '$.text'), ''),
    NULLIF(json_extract(${tableAlias}.payload_json, '$.message.text'), ''),
    NULLIF(json_extract(${tableAlias}.payload_json, '$.summary'), ''),
    NULLIF(json_extract(${tableAlias}.payload_json, '$.session.summary'), ''),
    (
      SELECT COALESCE(NULLIF(item.presentation_text, ''), NULLIF(item.text, ''))
      FROM session_items item
      WHERE item.session_id = ${tableAlias}.session_id
        AND item.turn_id = ${completionTurnId}
        AND item.type = 'agentMessage'
      ORDER BY CASE WHEN item.presentation_role = 'final_answer' THEN 0 ELSE 1 END,
               item.created_at DESC, item.id DESC
      LIMIT 1
    )
  )`;
  return `${tableAlias}.event_id, ${tableAlias}.session_id, ${tableAlias}.log_id,
    ${tableAlias}.sequence, ${tableAlias}.type, ${tableAlias}.producer,
    ${tableAlias}.surface, ${tableAlias}.source_event_seqs_json,
    ${tableAlias}.call_id, NULL AS source_json,
    CASE
      WHEN ${tableAlias}.type IN ('AgentTurnCompleted', 'CodexThreadCompleted', 'turn.completed')
      THEN json_object(
        'hasAgentMessage', json_extract(${tableAlias}.payload_json, '$.hasAgentMessage'),
        'turnId', ${completionTurnId},
        'item', json_object('type', 'agentMessage', 'text', ${projectedCompletionText},
                            'turnId', ${completionTurnId})
      )
      WHEN LOWER(${tableAlias}.type) LIKE '%tool.completed%'
        OR LOWER(${tableAlias}.type) LIKE '%tool/result%'
      THEN json_object(
        'turnId', json_extract(${tableAlias}.payload_json, '$.turnId'),
        'toolName', json_extract(${tableAlias}.payload_json, '$.toolName'),
        'summary', COALESCE(
          json_extract(${tableAlias}.payload_json, '$.summary'),
          json_extract(${tableAlias}.payload_json, '$.text'),
          'Historical tool result retained as evidence summary.'
        )
      )
      ELSE ${tableAlias}.payload_json
    END AS payload_json,
    ${tableAlias}.created_at`;
}
