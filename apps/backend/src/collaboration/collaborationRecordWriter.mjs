import { createCollaborationEnvelope } from "./collaborationProtocol.mjs";
import { messageFromRow } from "./collaborationRecordProjection.mjs";
import { requiredId, requiredText, optionalText, domainError } from "./collaborationValidation.mjs";

// Writes records inside the caller's transaction; it neither opens a separate
// connection nor commits independently of the surrounding Task transition.
export class CollaborationRecordWriter {
  constructor({ store, clock, idFactory, stableSessionIdentity, sessionIdentityMatches, requireService }) {
    Object.assign(this, { store, clock, idFactory, stableSessionIdentity, sessionIdentityMatches, requireService });
  }

  insertMessage(input) {
    const idempotencyKey = optionalText(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.store.selectOne(
        "SELECT * FROM collaboration_messages WHERE sender_session_id = ? AND idempotency_key = ?",
        [this.stableSessionIdentity(requiredId(input.senderSessionId, "senderSessionId")), idempotencyKey]
      );
      if (existing) {
        if (existing.task_id !== input.taskId) throw domainError("IDEMPOTENCY_CONFLICT", "Message idempotency key belongs to another task.");
        return messageFromRow(existing);
      }
    }
    const messageId = input.messageId ?? this.idFactory();
    const timestamp = input.timestamp ?? this.clock();
    const taskScope = this.store.selectOne(
      `SELECT initiator_agent_id, recipient_agent_id, initiator_session_id, recipient_session_id,
              source_work_id, target_work_id, source_task_id, target_task_id
       FROM collaboration_requests WHERE task_id = ?`,
      [input.taskId]
    );
    const sendsForward = this.sessionIdentityMatches(input.senderSessionId, taskScope?.initiator_session_id);
    const senderSessionId = this.stableSessionIdentity(input.senderSessionId
      ?? (sendsForward ? taskScope?.initiator_session_id : taskScope?.recipient_session_id)
      ?? null);
    const recipientSessionId = this.stableSessionIdentity(input.recipientSessionId
      ?? (sendsForward ? taskScope?.recipient_session_id : taskScope?.initiator_session_id)
      ?? null);
    if (!senderSessionId || !recipientSessionId || senderSessionId === recipientSessionId) {
      throw domainError("DISTINCT_SESSIONS_REQUIRED", "Every collaboration message requires two explicit, distinct Sessions.");
    }
    const sourceWorkId = input.sourceWorkId
      ?? (sendsForward ? taskScope?.source_work_id : taskScope?.target_work_id);
    const targetWorkId = input.targetWorkId
      ?? (sendsForward ? taskScope?.target_work_id : taskScope?.source_work_id);
    const sourceTaskId = input.sourceTaskId ?? taskScope?.source_task_id ?? null;
    const targetTaskId = input.targetTaskId ?? taskScope?.target_task_id;
    const payload = {
      body: requiredText(input.body, "body"),
      evidence: input.evidence ?? [],
      resourceVersion: optionalText(input.resourceVersion)
    };
    const envelope = createCollaborationEnvelope({
      messageId,
      taskId: input.taskId,
      messageType: input.messageType,
      senderAgentId: input.senderAgentId,
      recipientAgentId: input.recipientAgentId,
      senderSessionId,
      recipientSessionId,
      sourceWorkId,
      targetWorkId,
      sourceTaskId,
      targetTaskId,
      payload,
      timestamp,
      error: input.error ?? null
    });
    this.store.db.run(
      `INSERT INTO collaboration_messages (
        message_id, task_id, protocol_version, source_work_id, target_work_id,
        source_task_id, target_task_id, sender_agent_id, recipient_agent_id,
        sender_session_id, recipient_session_id, message_type, body,
        evidence_json, payload_json, error_json, resource_version, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId, input.taskId, envelope.version, sourceWorkId, targetWorkId,
        sourceTaskId, targetTaskId, input.senderAgentId, input.recipientAgentId,
        senderSessionId, recipientSessionId, input.messageType,
        payload.body, JSON.stringify(payload.evidence), JSON.stringify(payload),
        envelope.error ? JSON.stringify(envelope.error) : null, payload.resourceVersion,
        idempotencyKey, timestamp
      ]
    );
    this.store.db.run(
      `INSERT INTO collaboration_deliveries (
        delivery_id, message_id, recipient_agent_id, recipient_session_id, status, attempt_count, next_attempt_at,
        delivered_at, target_turn_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      [input.deliveryId ?? this.idFactory(), messageId, input.recipientAgentId, recipientSessionId, timestamp, timestamp]
    );
    return messageFromRow(this.store.selectOne("SELECT * FROM collaboration_messages WHERE message_id = ?", [messageId]));
  }

  insertArtifact(task, producerAgentId, producerSessionId, input, timestamp) {
    if (task.serviceId) {
      const service = this.requireService(task.serviceId);
      if (service.ownerAgentId !== producerAgentId) {
        throw domainError("SERVICE_OWNER_REQUIRED", `Only ${service.ownerAgentId} may publish artifacts for ${service.serviceId}.`);
      }
    }
    const artifactId = optionalText(input.artifactId) ?? this.idFactory();
    this.store.db.run(
      `INSERT INTO collaboration_artifacts (
        artifact_id, task_id, producer_agent_id, producer_session_id, type, name, uri, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId, task.taskId, producerAgentId, this.stableSessionIdentity(producerSessionId), requiredText(input.type, "artifact.type"),
        requiredText(input.name, "artifact.name"), requiredText(input.uri, "artifact.uri"),
        JSON.stringify(input.metadata ?? {}), timestamp
      ]
    );
    return artifactId;
  }

  appendEvent(taskId, type, actorAgentId, payload, timestamp, actorSessionId = null) {
    const row = this.store.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM collaboration_events WHERE task_id = ?",
      [taskId]
    );
    const sequence = Number(row?.sequence ?? 0) + 1;
    this.store.db.run(
      `INSERT INTO collaboration_events (
        event_id, task_id, sequence, type, actor_agent_id, actor_session_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.idFactory(), taskId, sequence, type, actorAgentId ?? null,
        this.stableSessionIdentity(actorSessionId), JSON.stringify(payload ?? {}), timestamp ?? this.clock()]
    );
  }
}
