import { createCollaborationEnvelope } from "./collaborationProtocol.mjs";
import { deliveryFromRow, parseJson } from "./collaborationRecordProjection.mjs";

// Read-side join and queue eligibility queries share the existing Store.
// Delivery claims and state transitions stay with the transactional core.
export class CollaborationDeliveryReader {
  constructor({ store, clock, listArtifacts }) {
    Object.assign(this, { store, clock, listArtifacts });
  }

  getDeliveryEnvelope(deliveryId) {
    const row = this.store.selectOne(
      `SELECT d.*, m.task_id, m.sender_agent_id, m.sender_session_id, m.recipient_session_id AS message_recipient_session_id,
              m.message_type, m.body,
              m.protocol_version, m.source_work_id AS message_source_work_id,
              m.target_work_id AS message_target_work_id,
              m.source_task_id AS message_source_task_id, m.target_task_id AS message_target_task_id,
              m.evidence_json, m.payload_json, m.error_json, m.resource_version, m.created_at AS message_created_at,
              t.context_id, t.service_id, t.type AS task_type, t.status AS task_status,
              t.initiator_agent_id, t.recipient_agent_id AS task_recipient_agent_id,
              t.initiator_session_id, t.recipient_session_id AS task_recipient_session_id,
              t.initiator_name_at_send, t.recipient_name_at_send,
              t.routing_version, t.route_status, t.routing_intent,
              t.source_work_id, t.target_work_id, t.source_task_id, t.target_task_id,
              t.iteration, t.max_iterations, t.title, t.summary,
              t.acceptance_criteria_json, a.name AS sender_agent_name,
              s.name AS service_name
       FROM collaboration_deliveries d
       JOIN collaboration_messages m ON m.message_id = d.message_id
       JOIN collaboration_requests t ON t.task_id = m.task_id
       JOIN agents a ON a.agent_id = m.sender_agent_id
       LEFT JOIN services s ON s.service_id = t.service_id
       WHERE d.delivery_id = ?`,
      [deliveryId]
    );
    if (!row) return null;
    const latestArtifact = this.listArtifacts(row.task_id).at(-1) ?? null;
    return {
      delivery: deliveryFromRow(row),
      message: {
        messageId: row.message_id,
        taskId: row.task_id,
        senderAgentId: row.sender_agent_id,
        senderAgentName: row.sender_agent_name,
        recipientAgentId: row.recipient_agent_id,
        messageType: row.message_type,
        body: row.body,
        evidence: parseJson(row.evidence_json, []),
        resourceVersion: row.resource_version || null,
        createdAt: row.message_created_at,
        envelope: row.sender_session_id && row.message_recipient_session_id ? createCollaborationEnvelope({
          messageId: row.message_id,
          taskId: row.task_id,
          messageType: row.message_type,
          senderAgentId: row.sender_agent_id,
          recipientAgentId: row.recipient_agent_id,
          senderSessionId: row.sender_session_id,
          recipientSessionId: row.message_recipient_session_id,
          sourceWorkId: row.message_source_work_id,
          targetWorkId: row.message_target_work_id,
          sourceTaskId: row.message_source_task_id,
          targetTaskId: row.message_target_task_id,
          payload: parseJson(row.payload_json, {
            body: row.body,
            evidence: parseJson(row.evidence_json, []),
            resourceVersion: row.resource_version || null
          }),
          timestamp: row.message_created_at,
          error: parseJson(row.error_json, null)
        }) : null
      },
      task: {
        taskId: row.task_id,
        targetTaskId: row.target_task_id,
        contextId: row.context_id,
        initiatorAgentId: row.initiator_agent_id,
        recipientAgentId: row.task_recipient_agent_id,
        initiatorSessionId: row.initiator_session_id || null,
        recipientSessionId: row.task_recipient_session_id || null,
        initiatorNameAtSend: row.initiator_name_at_send || null,
        recipientNameAtSend: row.recipient_name_at_send || null,
        sourceWorkId: row.source_work_id,
        targetWorkId: row.target_work_id,
        sourceTaskId: row.source_task_id || null,
        taskId: row.task_id,
        serviceId: row.service_id || null,
        serviceName: row.service_name || null,
        type: row.task_type,
        status: row.task_status,
        iteration: Number(row.iteration),
        maxIterations: Number(row.max_iterations),
        title: row.title,
        summary: row.summary,
        acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
        routingVersion: row.routing_version == null ? null : Number(row.routing_version),
        routeStatus: row.route_status || "unresolved",
        routingIntent: row.routing_intent || null
      },
      latestArtifact
    };
  }

  listPendingDeliveries(limit = 100, maxAttempts = Number.MAX_SAFE_INTEGER) {
    return this.store.selectAll(
      `SELECT * FROM collaboration_deliveries
       WHERE status IN ('pending', 'failed')
         AND attempt_count < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      [
        Math.max(1, Number(maxAttempts) || Number.MAX_SAFE_INTEGER),
        this.clock(),
        Math.max(1, Math.min(1000, Number(limit) || 100))
      ]
    ).map(deliveryFromRow);
  }

  listQueuedDeliveriesForAgent(agentId, limit = 100) {
    return this.store.selectAll(
      `SELECT * FROM collaboration_deliveries
       WHERE recipient_agent_id = ? AND status = 'queued'
       ORDER BY created_at ASC LIMIT ?`,
      [agentId, Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(deliveryFromRow);
  }

  listQueuedDeliveries(limit = 100) {
    return this.store.selectAll(
      `SELECT * FROM collaboration_deliveries WHERE status = 'queued'
       ORDER BY created_at ASC LIMIT ?`,
      [Math.max(1, Math.min(1000, Number(limit) || 100))]
    ).map(deliveryFromRow);
  }
}
