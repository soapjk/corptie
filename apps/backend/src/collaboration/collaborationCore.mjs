import { randomUUID } from "node:crypto";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborationEnvelope
} from "./collaborationProtocol.mjs";

const TERMINAL_TASK_STATUSES = new Set(["completed", "rejected", "canceled", "escalated"]);
const DELIVERY_STATUSES = new Set(["pending", "queued", "delivering", "delivered", "failed"]);
const TASK_INPUT_FIELDS = new Set([
  "taskId", "confirmationId", "initiatorAgentId", "recipientAgentId", "recipientSessionName",
  "serviceId", "type", "title", "summary", "acceptanceCriteria", "evidence", "resourceVersion",
  "maxIterations", "idempotencyKey", "messageIdempotencyKey", "parentTaskId", "contextId",
  "contextTitle", "contextMetadata", "messageId", "deliveryId", "sourceSessionId", "sourceTurnId",
  "initiatorSessionId", "recipientSessionId", "initiatorNameAtSend", "recipientNameAtSend",
  "sourceObjectiveId", "targetObjectiveId", "sourceWorkItemId", "workItemId",
  "routingVersion", "routeStatus", "initiatorBindingId", "recipientBindingId", "routingIntent",
  "presentation"
]);

export class CollaborationCore {
  constructor(store, options = {}) {
    this.store = store;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.initialize();
  }

  initialize() {
    const result = this.#migrateLegacyCollaborationTasks();
    if (this.store.db) this.#recordChannelSchemaMigration();
    return result;
  }

  registerAgent(input) {
    const agentId = requiredId(input.agentId, "agentId");
    const name = requiredText(input.name, "name");
    const timestamp = this.clock();
    const existing = this.getAgent(agentId);
    this.store.db.run(
      `INSERT INTO agents (
        agent_id, name, description, status, capabilities_json, current_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at`,
      [
        agentId,
        name,
        optionalText(input.description) ?? "",
        "available",
        JSON.stringify(stringList(input.capabilities)),
        existing?.createdAt ?? timestamp,
        timestamp
      ]
    );
    this.store.scheduleSave();
    return this.getAgent(agentId);
  }

  getAgent(agentId) {
    const row = this.store.selectOne("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
    return row ? agentFromRow(row, this.store) : null;
  }

  getAgentForSession(sessionId) {
    const logical = this.store.getLogicalSession(sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const row = this.store.selectOne(
      `SELECT a.* FROM agents a
       JOIN agent_sessions s ON s.agent_id = a.agent_id
       WHERE s.session_id IN (?, ?) AND s.unbound_at IS NULL
       ORDER BY s.bound_at DESC LIMIT 1`,
      [sessionId, logical?.legacySessionId ?? sessionId]
    );
    return row ? agentFromRow(row, this.store, logical) : null;
  }

  resolveAgentBySessionName(sessionName) {
    const logical = this.store.getLogicalSessionByName(sessionName);
    if (!logical) return null;
    const row = this.store.selectOne(
      `SELECT a.* FROM agents a
       JOIN agent_sessions binding ON binding.agent_id = a.agent_id
       WHERE binding.unbound_at IS NULL
         AND binding.session_id IN (?, ?)
       ORDER BY binding.bound_at DESC LIMIT 1`,
      [logical.logicalSessionId, logical.legacySessionId]
    );
    return row ? agentFromRow(row, this.store, logical) : null;
  }

  listAgents(options = {}) {
    const agents = this.store.selectAll("SELECT * FROM agents ORDER BY name ASC")
      .map((row) => agentFromRow(row, this.store));
    return options.status ? agents.filter((agent) => agent.status === options.status) : agents;
  }

  bindSession(input) {
    const agent = this.#requireAgent(input.agentId);
    const sessionId = requiredId(input.sessionId, "sessionId");
    const timestamp = this.clock();
    this.#transaction(() => {
      const other = this.store.selectOne(
        "SELECT agent_id FROM agent_sessions WHERE session_id = ? AND unbound_at IS NULL",
        [sessionId]
      );
      if (other && other.agent_id !== agent.agentId) {
        throw domainError("SESSION_ALREADY_BOUND", `Session ${sessionId} is already bound to agent ${other.agent_id}.`);
      }
      const current = this.store.selectOne(
        "SELECT binding_id FROM agent_sessions WHERE agent_id = ? AND session_id = ? AND unbound_at IS NULL",
        [agent.agentId, sessionId]
      );
      if (!current) {
        this.store.db.run(
          "INSERT INTO agent_sessions (binding_id, agent_id, session_id, bound_at, unbound_at) VALUES (?, ?, ?, ?, NULL)",
          [this.idFactory(), agent.agentId, sessionId, timestamp]
        );
      }
      this.store.db.run(
        `UPDATE sessions SET
           agent_id = ?,
           session_kind = CASE
             WHEN session_kind = 'legacy' AND ? = 'assistant' THEN 'assistantChat'
             ELSE session_kind
           END,
           updated_at = ?
         WHERE id = ?
           AND (
             agent_id IS NOT ?
             OR (session_kind = 'legacy' AND ? = 'assistant')
           )`,
        [agent.agentId, agent.role, timestamp, sessionId, agent.agentId, agent.role]
      );
      // Re-observing an existing Provider projection must not rotate an Agent's
      // current Session through every historical active binding. Only a newly
      // created binding advances the recency cursor.
      if (!current) {
        this.store.db.run(
          `UPDATE agents SET current_session_id = ?, updated_at = ?
           WHERE agent_id = ? AND current_session_id IS NOT ?`,
          [sessionId, timestamp, agent.agentId, sessionId]
        );
      }
    });
    return this.getAgent(agent.agentId);
  }

  unbindSession(agentId) {
    const agent = this.#requireAgent(agentId);
    if (!agent.currentSessionId) return agent;
    const timestamp = this.clock();
    this.#transaction(() => {
      this.store.db.run(
        "UPDATE agent_sessions SET unbound_at = ? WHERE agent_id = ? AND unbound_at IS NULL",
        [timestamp, agent.agentId]
      );
      this.store.db.run(
        "UPDATE agents SET current_session_id = NULL, updated_at = ? WHERE agent_id = ?",
        [timestamp, agent.agentId]
      );
    });
    return this.getAgent(agent.agentId);
  }

  detachSession(sessionId) {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const stableSessionId = this.#stableSessionIdentity(normalizedSessionId);
    const agent = this.store.selectOne(
      `SELECT a.agent_id
       FROM agents a
       LEFT JOIN agent_sessions s
         ON s.agent_id = a.agent_id
        AND s.session_id = ?
        AND s.unbound_at IS NULL
       WHERE a.current_session_id = ? OR s.session_id = ?
       LIMIT 1`,
      [normalizedSessionId, normalizedSessionId, normalizedSessionId]
    );
    if (!agent) return null;

    const timestamp = this.clock();
    this.#transaction(() => {
      this.#invalidateChannelsForSession(stableSessionId, "session_detached", timestamp);
      this.store.db.run(
        "UPDATE agent_sessions SET unbound_at = ? WHERE session_id = ? AND unbound_at IS NULL",
        [timestamp, normalizedSessionId]
      );
      this.store.db.run(
        `UPDATE agents SET
           current_session_id = (
             SELECT session_id FROM agent_sessions
             WHERE agent_id = ? AND unbound_at IS NULL
             ORDER BY bound_at DESC LIMIT 1
           ),
           updated_at = ?
         WHERE agent_id = ?`,
        [agent.agent_id, timestamp, agent.agent_id]
      );
    });
    this.store.scheduleSave();
    return this.getAgent(agent.agent_id);
  }

  detachMissingSessionBindings() {
    const sessionIds = this.store.selectAll(
      `SELECT DISTINCT session_id
       FROM (
         SELECT current_session_id AS session_id
         FROM agents
         WHERE current_session_id IS NOT NULL
         UNION
         SELECT session_id
         FROM agent_sessions
         WHERE unbound_at IS NULL
       )
       WHERE session_id NOT IN (SELECT id FROM sessions)`
    ).map((row) => row.session_id);

    return sessionIds
      .map((sessionId) => this.detachSession(sessionId))
      .filter(Boolean);
  }

  registerService(input) {
    const serviceId = requiredId(input.serviceId, "serviceId");
    const owner = this.#requireAgent(input.ownerAgentId);
    const timestamp = this.clock();
    const existing = this.getService(serviceId);
    if (existing && existing.ownerAgentId !== owner.agentId) {
      throw domainError("SERVICE_OWNER_MISMATCH", "Service ownership transfer requires a separate explicit workflow.");
    }
    const status = input.status ?? existing?.status ?? "unknown";
    if (!["unknown", "stopped", "starting", "running", "degraded", "failed", "inactive"].includes(status)) {
      throw domainError("INVALID_SERVICE_STATUS", `Unsupported service status: ${status}`);
    }
    this.store.db.run(
      `INSERT INTO services (
        service_id, name, description, owner_agent_id, current_version, status, endpoint,
        repository_root, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        current_version = excluded.current_version,
        status = excluded.status,
        endpoint = excluded.endpoint,
        repository_root = excluded.repository_root,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      [
        serviceId,
        requiredText(input.name, "name"),
        optionalText(input.description) ?? "",
        owner.agentId,
        optionalText(input.currentVersion),
        status,
        optionalText(input.endpoint),
        optionalText(input.repositoryRoot),
        JSON.stringify(input.metadata ?? {}),
        existing?.createdAt ?? timestamp,
        timestamp
      ]
    );
    this.store.scheduleSave();
    return this.getService(serviceId);
  }

  updateService(serviceId, actorAgentId, patch = {}) {
    const service = this.#requireService(serviceId);
    if (service.ownerAgentId !== actorAgentId) {
      throw domainError("SERVICE_OWNER_REQUIRED", `Only ${service.ownerAgentId} may update service ${serviceId}.`);
    }
    return this.registerService({
      serviceId,
      ownerAgentId: service.ownerAgentId,
      name: patch.name ?? service.name,
      description: patch.description ?? service.description,
      currentVersion: patch.currentVersion ?? service.currentVersion,
      status: patch.status ?? service.status,
      endpoint: patch.endpoint ?? service.endpoint,
      repositoryRoot: patch.repositoryRoot ?? service.repositoryRoot,
      metadata: patch.metadata ?? service.metadata
    });
  }

  getService(serviceId) {
    const row = this.store.selectOne("SELECT * FROM services WHERE service_id = ?", [serviceId]);
    return row ? serviceFromRow(row) : null;
  }

  listServices(options = {}) {
    const conditions = [];
    const params = [];
    if (options.ownerAgentId) {
      conditions.push("owner_agent_id = ?");
      params.push(options.ownerAgentId);
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.store.selectAll(`SELECT * FROM services ${where} ORDER BY name ASC`, params).map(serviceFromRow);
  }

  addServiceConsumer(serviceId, agentId) {
    this.#requireService(serviceId);
    this.#requireAgent(agentId);
    this.store.db.run(
      "INSERT OR IGNORE INTO service_consumers (service_id, agent_id, created_at) VALUES (?, ?, ?)",
      [serviceId, agentId, this.clock()]
    );
    this.store.scheduleSave();
    return this.listServiceConsumers(serviceId);
  }

  listServiceConsumers(serviceId) {
    return this.store.selectAll(
      `SELECT a.* FROM agents a
       JOIN service_consumers c ON c.agent_id = a.agent_id
       WHERE c.service_id = ? ORDER BY a.name ASC`,
      [serviceId]
    ).map((row) => agentFromRow(row, this.store));
  }

  createTask(input) {
    assertKnownFields(input, TASK_INPUT_FIELDS);
    const initiator = this.#requireAgent(input.initiatorAgentId);
    const recipient = this.#requireAgent(input.recipientAgentId);
    this.#assertSessionParticipants(input, initiator, recipient);
    const taskType = input.type ?? "change_request";
    if (!["question", "change_request"].includes(taskType)) {
      throw domainError("INVALID_TASK_TYPE", `Unsupported task type: ${taskType}`);
    }
    const idempotencyKey = optionalText(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.store.selectOne(
        "SELECT task_id FROM collaboration_tasks WHERE initiator_agent_id = ? AND idempotency_key = ?",
        [initiator.agentId, idempotencyKey]
      );
      if (existing) return this.getTask(existing.task_id);
    }
    const service = input.serviceId ? this.#requireService(input.serviceId) : null;
    if (service && service.ownerAgentId !== recipient.agentId) {
      throw domainError("RECIPIENT_NOT_SERVICE_OWNER", `Agent ${recipient.agentId} does not own service ${service.serviceId}.`);
    }
    if (input.parentTaskId) this.#requireTask(input.parentTaskId);

    const taskId = optionalText(input.taskId) ?? this.idFactory();
    const contextId = optionalText(input.contextId) ?? this.idFactory();
    const messageId = optionalText(input.messageId) ?? this.idFactory();
    const deliveryId = optionalText(input.deliveryId) ?? this.idFactory();
    const timestamp = this.clock();
    const maxIterations = positiveInteger(input.maxIterations, 3);
    const title = requiredText(input.title, "title");
    const summary = requiredText(input.summary, "summary");
    const acceptanceCriteria = stringList(input.acceptanceCriteria);
    const scope = this.#resolveTaskScope(input, initiator, recipient);

    this.#transaction(() => {
      const workItem = this.#ensureCollaborationWorkItem({
        requestedWorkItemId: input.workItemId,
        taskId,
        targetObjectiveId: scope.targetObjectiveId,
        recipientAgentId: recipient.agentId,
        title,
        summary,
        acceptanceCriteria,
        status: "todo"
      });
      this.store.db.run(
        `INSERT OR IGNORE INTO collaboration_contexts (
          context_id, title, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [contextId, optionalText(input.contextTitle) ?? title, JSON.stringify(input.contextMetadata ?? {}), timestamp, timestamp]
      );
      this.store.db.run(
        `INSERT INTO collaboration_tasks (
          task_id, context_id, parent_task_id, protocol_version,
          source_objective_id, target_objective_id, source_work_item_id, work_item_id,
          initiator_agent_id, recipient_agent_id, service_id,
          type, status, iteration, max_iterations, title, summary, acceptance_criteria_json,
          idempotency_key, created_at, updated_at, completed_at,
          initiator_session_id, recipient_session_id, initiator_name_at_send, recipient_name_at_send,
          routing_version, route_status, routing_intent, artifact_status, acceptance_status,
          initiator_binding_id, recipient_binding_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`,
        [
          taskId, contextId, optionalText(input.parentTaskId), COLLABORATION_PROTOCOL_VERSION,
          scope.sourceObjectiveId, scope.targetObjectiveId, scope.sourceWorkItemId, workItem.id,
          initiator.agentId, recipient.agentId, service?.serviceId ?? null, taskType,
          maxIterations, title, summary, JSON.stringify(acceptanceCriteria), idempotencyKey, timestamp, timestamp,
          input.initiatorSessionId ?? initiator.sessionId,
          this.#initialRecipientSessionId(input, recipient),
          input.initiatorNameAtSend ?? initiator.sessionName,
          input.recipientNameAtSend ?? recipient.sessionName,
          scope.routingVersion,
          scope.routeStatus,
          optionalText(input.routingIntent),
          scope.initiatorBindingId,
          scope.recipientBindingId
        ]
      );
      this.store.db.run(
        `INSERT INTO collaboration_participants (task_id, agent_id, role, created_at)
         VALUES (?, ?, 'initiator', ?)`,
        [taskId, initiator.agentId, timestamp]
      );
      if (recipient.agentId !== initiator.agentId) {
        this.store.db.run(
          `INSERT INTO collaboration_participants (task_id, agent_id, role, created_at)
           VALUES (?, ?, 'recipient', ?)`,
          [taskId, recipient.agentId, timestamp]
        );
      }
      this.#insertMessage({
        messageId,
        taskId,
        senderAgentId: initiator.agentId,
        recipientAgentId: recipient.agentId,
        sourceObjectiveId: scope.sourceObjectiveId,
        targetObjectiveId: scope.targetObjectiveId,
        sourceWorkItemId: scope.sourceWorkItemId,
        workItemId: workItem.id,
        messageType: taskType,
        body: summary,
        evidence: input.evidence,
        resourceVersion: input.resourceVersion,
        idempotencyKey: optionalText(input.messageIdempotencyKey),
        deliveryId,
        senderSessionId: input.initiatorSessionId ?? initiator.sessionId,
        recipientSessionId: this.#initialRecipientSessionId(input, recipient),
        timestamp
      });
      this.#appendEvent(taskId, "task_created", initiator.agentId, {
        status: "proposed",
        messageId,
        recipientAgentId: recipient.agentId,
        sourceObjectiveId: scope.sourceObjectiveId,
        targetObjectiveId: scope.targetObjectiveId,
        workItemId: workItem.id
      }, timestamp);
    });
    return this.getTask(taskId);
  }

  proposeTask(input) {
    assertKnownFields(input, TASK_INPUT_FIELDS);
    const initiator = this.#requireAgent(input.initiatorAgentId);
    const recipient = this.#requireAgent(input.recipientAgentId);
    this.#assertSessionParticipants(input, initiator, recipient);
    const taskType = input.type ?? "change_request";
    if (!["question", "change_request"].includes(taskType)) {
      throw domainError("INVALID_TASK_TYPE", `Unsupported task type: ${taskType}`);
    }
    const service = input.serviceId ? this.#requireService(input.serviceId) : null;
    if (service && service.ownerAgentId !== recipient.agentId) {
      throw domainError("RECIPIENT_NOT_SERVICE_OWNER", `Agent ${recipient.agentId} does not own service ${service.serviceId}.`);
    }
    if (input.parentTaskId) this.#requireTask(input.parentTaskId);
    const scope = this.#resolveTaskScope(input, initiator, recipient);
    if (input.workItemId) {
      this.#validateRequestedWorkItem(input.workItemId, scope.targetObjectiveId, recipient.agentId);
    }
    const initiatorSessionId = input.initiatorSessionId ?? initiator.sessionId;
    const recipientSessionId = this.#initialRecipientSessionId(input, recipient);
    const initiatorSession = sessionPresentationSnapshot(this.store, initiatorSessionId);
    const recipientSession = sessionPresentationSnapshot(this.store, recipientSessionId);
    const sourceObjective = this.store.getObjective(scope.sourceObjectiveId);
    const targetObjective = this.store.getObjective(scope.targetObjectiveId);
    const request = {
      ...input,
      initiatorAgentId: initiator.agentId,
      recipientAgentId: recipient.agentId,
      initiatorSessionId,
      recipientSessionId,
      initiatorNameAtSend: input.initiatorNameAtSend ?? initiatorSession?.title ?? initiator.sessionName,
      recipientNameAtSend: input.recipientNameAtSend ?? recipientSession?.title
        ?? (recipientSessionId ? recipient.sessionName : null),
      sourceObjectiveId: scope.sourceObjectiveId,
      targetObjectiveId: scope.targetObjectiveId,
      sourceWorkItemId: scope.sourceWorkItemId,
      routingVersion: scope.routingVersion,
      routeStatus: scope.routeStatus,
      initiatorBindingId: scope.initiatorBindingId,
      recipientBindingId: scope.recipientBindingId,
      type: taskType,
      title: requiredText(input.title, "title"),
      summary: requiredText(input.summary, "summary"),
      acceptanceCriteria: stringList(input.acceptanceCriteria),
      maxIterations: positiveInteger(input.maxIterations, 3)
    };
    request.presentation = {
      initiatorAgentName: initiator.name,
      recipientAgentName: recipient.name,
      sourceObjective: { id: scope.sourceObjectiveId, name: sourceObjective?.name ?? scope.sourceObjectiveId },
      targetObjective: { id: scope.targetObjectiveId, name: targetObjective?.name ?? scope.targetObjectiveId },
      initiatorSession,
      recipientSession,
      routingIntent: optionalText(input.routingIntent)
    };
    const confirmationId = optionalText(input.confirmationId) ?? this.idFactory();
    const timestamp = this.clock();
    this.store.db.run(
      `INSERT INTO collaboration_request_confirmations (
        confirmation_id, initiator_agent_id, recipient_agent_id, source_session_id, source_turn_id,
        request_json, status, task_id, created_at, resolved_at,
        initiator_session_id, recipient_session_id, initiator_name_at_send, recipient_name_at_send
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?, ?, ?)`,
      [
        confirmationId, initiator.agentId, recipient.agentId,
        optionalText(input.sourceSessionId) ?? initiator.currentSessionId,
        optionalText(input.sourceTurnId), JSON.stringify(request), timestamp,
        request.initiatorSessionId, request.recipientSessionId, request.initiatorNameAtSend, request.recipientNameAtSend
      ]
    );
    this.store.scheduleSave();
    return this.getTaskConfirmation(confirmationId);
  }

  getTaskConfirmation(confirmationId) {
    const row = this.store.selectOne(
      "SELECT * FROM collaboration_request_confirmations WHERE confirmation_id = ?",
      [confirmationId]
    );
    return row ? taskConfirmationFromRow(row, this) : null;
  }

  listTaskConfirmationsForSession(sessionId) {
    return this.store.selectAll(
      `SELECT * FROM collaboration_request_confirmations
       WHERE source_session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    ).map((row) => taskConfirmationFromRow(row, this));
  }

  pendingTaskConfirmationForSession(sessionId) {
    const row = this.store.selectOne(
      `SELECT * FROM collaboration_request_confirmations
       WHERE source_session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    return row ? taskConfirmationFromRow(row, this) : null;
  }

  confirmTaskConfirmation(confirmationId) {
    const confirmation = this.getTaskConfirmation(confirmationId);
    if (!confirmation) throw domainError("CONFIRMATION_NOT_FOUND", "Collaboration confirmation was not found.");
    if (confirmation.status === "confirmed") return confirmation;
    if (confirmation.status !== "pending") throw domainError("CONFIRMATION_ALREADY_RESOLVED", "Collaboration confirmation was already rejected.");
    const task = this.createTask({
      ...confirmation.request,
      idempotencyKey: confirmation.request.idempotencyKey ?? `confirmation:${confirmation.confirmationId}`
    });
    this.store.db.run(
      `UPDATE collaboration_request_confirmations
       SET status = 'confirmed', task_id = ?, resolved_at = ? WHERE confirmation_id = ? AND status = 'pending'`,
      [task.taskId, this.clock(), confirmationId]
    );
    this.store.scheduleSave();
    return this.getTaskConfirmation(confirmationId);
  }

  rejectTaskConfirmation(confirmationId) {
    const confirmation = this.getTaskConfirmation(confirmationId);
    if (!confirmation) throw domainError("CONFIRMATION_NOT_FOUND", "Collaboration confirmation was not found.");
    if (confirmation.status !== "pending") return confirmation;
    this.store.db.run(
      `UPDATE collaboration_request_confirmations
       SET status = 'rejected', resolved_at = ? WHERE confirmation_id = ? AND status = 'pending'`,
      [this.clock(), confirmationId]
    );
    this.store.scheduleSave();
    return this.getTaskConfirmation(confirmationId);
  }

  getTask(taskId) {
    const row = this.store.selectOne("SELECT * FROM collaboration_tasks WHERE task_id = ?", [taskId]);
    if (!row) return null;
    return {
      ...taskFromRow(row),
      messages: this.listMessages(taskId),
      artifacts: this.listArtifacts(taskId),
      events: this.listEvents(taskId)
    };
  }

  getChannel(taskId) {
    const row = this.store.selectOne(
      "SELECT * FROM collaboration_channels WHERE task_id = ?",
      [requiredId(taskId, "taskId")]
    );
    return row ? channelFromRow(row) : null;
  }

  resolveDirectReplyRoute(deliveryId) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    const reply = this.#isReplyEnvelope(envelope);

    const channel = this.getChannel(envelope.task.taskId);
    if (channel?.status === "active") {
      const senderSessionId = this.#stableSessionIdentity(envelope.message.envelope.sender.sessionId);
      const expectedSenderSessionId = reply ? channel.recipientSessionId : channel.initiatorSessionId;
      const expectedSenderAgentId = reply ? channel.recipientAgentId : channel.initiatorAgentId;
      const expectedRecipientAgentId = reply ? channel.initiatorAgentId : channel.recipientAgentId;
      const targetSessionId = reply ? channel.initiatorSessionId : channel.recipientSessionId;
      if (senderSessionId === expectedSenderSessionId
          && envelope.message.senderAgentId === expectedSenderAgentId
          && envelope.delivery.recipientAgentId === expectedRecipientAgentId) {
        const route = this.#activeProviderRoute(targetSessionId, expectedRecipientAgentId);
        if (route) return { ...route, mode: "channel", channel };
        this.#invalidateChannel(channel.channelId, reply ? "initiator_session_unavailable" : "recipient_session_unavailable");
      } else {
        this.#invalidateChannel(channel.channelId, "task_endpoint_mismatch");
      }
    }

    if (!reply) return null;
    const fallbackSessionId = this.#stableSessionIdentity(envelope.message.envelope.recipient.sessionId);
    const fallback = this.#activeProviderRoute(fallbackSessionId, envelope.delivery.recipientAgentId);
    if (fallback) return { ...fallback, mode: "fallback", channel: this.getChannel(envelope.task.taskId) };
    throw domainError(
      "COLLABORATION_CHANNEL_UNAVAILABLE",
      `No valid collaboration channel or original Session route remains for task ${envelope.task.taskId}.`
    );
  }

  rerouteTaskRecipient(taskId, recipientSessionId, details = {}) {
    const task = this.#requireTask(taskId);
    const targetAgent = this.getAgentForSession(recipientSessionId);
    if (targetAgent?.agentId !== task.recipientAgentId) {
      throw domainError("RECIPIENT_SESSION_AGENT_MISMATCH", "The replacement Session is not bound to the collaboration recipient Agent.");
    }
    const route = this.#routeForSession(recipientSessionId);
    if (route?.objectiveId !== task.targetObjectiveId) {
      throw domainError("TARGET_OBJECTIVE_MISMATCH", "The replacement Session does not belong to the collaboration target Objective.");
    }
    const stableSessionId = this.#stableSessionIdentity(recipientSessionId);
    const timestamp = this.clock();
    this.#transaction(() => {
      this.store.db.run(
        `UPDATE collaboration_tasks SET recipient_session_id=?, routing_version=?, recipient_binding_id=?,
         route_status='active', updated_at=? WHERE task_id=?`,
        [stableSessionId, route.routingVersion, route.bindingId, timestamp, taskId]
      );
      this.store.db.run(
        `UPDATE collaboration_messages SET recipient_session_id=? WHERE task_id=? AND message_id IN (
           SELECT message_id FROM collaboration_deliveries WHERE status != 'delivered'
         )`,
        [stableSessionId, taskId]
      );
      this.#appendEvent(taskId, "recipient_route_reselected", task.recipientAgentId, {
        previousSessionId: task.recipientSessionId,
        recipientSessionId: stableSessionId,
        routingVersion: route.routingVersion,
        ...details
      }, timestamp);
    });
    return this.getTask(taskId);
  }

  listInbox(agentId, options = {}) {
    this.#requireAgent(agentId);
    return this.#listTasks("recipient_agent_id", agentId, options);
  }

  listOutbox(agentId, options = {}) {
    this.#requireAgent(agentId);
    return this.#listTasks("initiator_agent_id", agentId, options);
  }

  listTasks(options = {}) {
    const conditions = [];
    const params = [];
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      if (statuses.length) {
        conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(500, Number(options.limit) || 200)));
    return this.store.selectAll(
      `SELECT * FROM collaboration_tasks ${where} ORDER BY updated_at DESC LIMIT ?`,
      params
    ).map(taskFromRow);
  }

  accept(taskId, actorAgentId, actorSessionId = null) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "recipient", actorSessionId);
    this.#assertRecipientRouteMetadata(task);
    return this.#transition(taskId, actorAgentId, ["proposed"], "accepted", "task_accepted", "recipient", {}, actorSessionId);
  }

  reject(taskId, actorAgentId, reason, actorSessionId = null) {
    return this.#transition(taskId, actorAgentId, ["proposed", "needs_information"], "rejected", "task_rejected", "recipient", { reason: requiredText(reason, "reason") }, actorSessionId);
  }

  startWorking(taskId, actorAgentId, actorSessionId = null) {
    return this.#transition(taskId, actorAgentId, ["accepted", "revision_requested"], "working", "work_started", "recipient", {}, actorSessionId);
  }

  askForInformation(taskId, actorAgentId, body, options = {}) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "recipient", options.actorSessionId);
    this.#assertStatus(task, ["proposed", "accepted"]);
    return this.#messageTransition(task, {
      actorAgentId,
      recipientAgentId: task.initiatorAgentId,
      messageType: "needs_information",
      body,
      options,
      nextStatus: "needs_information",
      eventType: "information_requested"
    });
  }

  replyWithInformation(taskId, actorAgentId, body, options = {}) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "initiator", options.actorSessionId);
    this.#assertStatus(task, ["needs_information"]);
    return this.#messageTransition(task, {
      actorAgentId,
      recipientAgentId: task.recipientAgentId,
      messageType: "question",
      body,
      options,
      nextStatus: "proposed",
      eventType: "information_provided"
    });
  }

  reply(taskId, actorAgentId, body, options = {}) {
    const task = this.#requireTask(taskId);
    const sameAgent = task.initiatorAgentId === task.recipientAgentId;
    const initiatorSessionMatches = this.#sessionIdentityMatches(options.actorSessionId, task.initiatorSessionId);
    const recipientSessionMatches = this.#sessionIdentityMatches(options.actorSessionId, task.recipientSessionId);
    const isInitiator = actorAgentId === task.initiatorAgentId
      && (initiatorSessionMatches || (!sameAgent && (!options.actorSessionId || !task.initiatorSessionId)));
    const isRecipient = actorAgentId === task.recipientAgentId
      && (recipientSessionMatches || (!sameAgent && (!options.actorSessionId || !task.recipientSessionId)));
    if (!isInitiator && !isRecipient) {
      throw domainError("ACTOR_NOT_AUTHORIZED", "Only task participants may reply.");
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw domainError("TASK_TERMINAL", `Task ${taskId} is already ${task.status}.`);
    }
    if (task.status === "needs_information" && isInitiator) {
      return this.replyWithInformation(taskId, actorAgentId, body, options);
    }
    if (task.type === "question" && isInitiator) {
      throw domainError(
        "QUESTION_FOLLOWUP_REQUIRES_NEW_TASK",
        "A new user question must be created as a new collaboration task. Initiators may only answer an explicit needs-information request on an existing question task."
      );
    }
    const timestamp = this.clock();
    this.#transaction(() => {
      const message = this.#insertMessage({
        taskId,
        senderAgentId: actorAgentId,
        recipientAgentId: isInitiator ? task.recipientAgentId : task.initiatorAgentId,
        messageType: "question",
        body: requiredText(body, "body"),
        evidence: options.evidence,
        resourceVersion: options.resourceVersion,
        idempotencyKey: optionalText(options.idempotencyKey),
        senderSessionId: options.actorSessionId,
        recipientSessionId: isInitiator ? task.recipientSessionId : task.initiatorSessionId,
        timestamp
      });
      const questionAnswered = task.type === "question" && isRecipient;
      this.#appendEvent(
        taskId,
        questionAnswered ? "question_answered" : "message_sent",
        actorAgentId,
        { messageId: message.messageId },
        timestamp
      );
      this.#updateTaskStatus(taskId, questionAnswered ? "completed" : task.status, timestamp);
    });
    return this.getTask(taskId);
  }

  submitResult(taskId, actorAgentId, input) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "recipient", input.actorSessionId);
    this.#assertStatus(task, ["working"]);
    const artifact = input.artifact;
    if (!artifact) throw domainError("ARTIFACT_REQUIRED", "A delivered result requires an artifact.");
    const timestamp = this.clock();
    this.#transaction(() => {
      const artifactId = this.#insertArtifact(task, actorAgentId, artifact, timestamp);
      const message = this.#insertMessage({
        taskId,
        senderAgentId: actorAgentId,
        recipientAgentId: task.initiatorAgentId,
        messageType: "update_ready",
        body: requiredText(input.body, "body"),
        evidence: input.evidence,
        resourceVersion: input.resourceVersion ?? artifact.metadata?.version,
        idempotencyKey: optionalText(input.idempotencyKey),
        senderSessionId: input.actorSessionId,
        recipientSessionId: task.initiatorSessionId,
        timestamp
      });
      this.#updateTaskStatus(taskId, "delivered", timestamp);
      this.#appendEvent(taskId, "result_delivered", actorAgentId, { messageId: message.messageId, artifactId }, timestamp);
    });
    return this.getTask(taskId);
  }

  beginVerification(taskId, actorAgentId, actorSessionId = null) {
    return this.#transition(taskId, actorAgentId, ["delivered"], "verifying", "verification_started", "initiator", {}, actorSessionId);
  }

  complete(taskId, actorAgentId, body, options = {}) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "initiator", options.actorSessionId);
    this.#assertStatus(task, ["verifying"]);
    return this.#messageTransition(task, {
      actorAgentId,
      recipientAgentId: task.recipientAgentId,
      messageType: "verification_result",
      body,
      options,
      nextStatus: "completed",
      eventType: "task_completed"
    });
  }

  requestRevision(taskId, actorAgentId, body, options = {}) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, "initiator", options.actorSessionId);
    this.#assertStatus(task, ["verifying"]);
    const nextStatus = task.iteration >= task.maxIterations ? "escalated" : "revision_requested";
    const nextIteration = nextStatus === "revision_requested" ? task.iteration + 1 : task.iteration;
    return this.#messageTransition(task, {
      actorAgentId,
      recipientAgentId: task.recipientAgentId,
      messageType: "verification_result",
      body,
      options,
      nextStatus,
      nextIteration,
      eventType: nextStatus === "escalated" ? "iteration_limit_reached" : "revision_requested"
    });
  }

  cancel(taskId, actorAgentId, reason, actorSessionId = null) {
    const task = this.#requireTask(taskId);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw domainError("TASK_TERMINAL", `Task ${taskId} is already ${task.status}.`);
    }
    return this.#transition(taskId, actorAgentId, [task.status], "canceled", "task_canceled", "initiator", { reason: requiredText(reason, "reason") }, actorSessionId);
  }

  cancelByUser(taskId, reason) {
    const task = this.#requireTask(taskId);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw domainError("TASK_TERMINAL", `Task ${taskId} is already ${task.status}.`);
    }
    const timestamp = this.clock();
    this.#transaction(() => {
      this.#updateTaskStatus(taskId, "canceled", timestamp);
      this.#appendEvent(taskId, "user_intervention", null, {
        action: "cancel",
        from: task.status,
        to: "canceled",
        reason: requiredText(reason, "reason")
      }, timestamp);
    });
    return this.getTask(taskId);
  }

  listMessages(taskId) {
    return this.store.selectAll(
      "SELECT * FROM collaboration_messages WHERE task_id = ? ORDER BY created_at ASC, message_id ASC",
      [taskId]
    ).map(messageFromRow);
  }

  listArtifacts(taskId) {
    return this.store.selectAll(
      "SELECT * FROM collaboration_artifacts WHERE task_id = ? ORDER BY created_at ASC, artifact_id ASC",
      [taskId]
    ).map(artifactFromRow);
  }

  listEvents(taskId, after = 0, limit = 200) {
    return this.store.selectAll(
      `SELECT * FROM collaboration_events WHERE task_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
      [taskId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(1000, Number(limit) || 200))]
    ).map(eventFromRow);
  }

  getDelivery(deliveryId) {
    const row = this.store.selectOne("SELECT * FROM collaboration_deliveries WHERE delivery_id = ?", [deliveryId]);
    return row ? deliveryFromRow(row) : null;
  }

  listDeliveriesForTask(taskId) {
    this.#requireTask(taskId);
    return this.store.selectAll(
      `SELECT d.* FROM collaboration_deliveries d
       JOIN collaboration_messages m ON m.message_id = d.message_id
       WHERE m.task_id = ? ORDER BY d.created_at ASC, d.delivery_id ASC`,
      [taskId]
    ).map(deliveryFromRow);
  }

  retryDeliveryByUser(deliveryId) {
    const delivery = this.getDelivery(deliveryId);
    if (!delivery) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    if (delivery.status === "delivered" || delivery.status === "delivering") {
      throw domainError("INVALID_DELIVERY_STATUS", `Delivery ${deliveryId} is ${delivery.status} and cannot be retried.`);
    }
    const envelope = this.getDeliveryEnvelope(deliveryId);
    const timestamp = this.clock();
    this.#transaction(() => {
      this.store.db.run(
        `UPDATE collaboration_deliveries SET status = 'pending', attempt_count = 0,
         next_attempt_at = NULL, delivered_at = NULL, target_turn_id = NULL,
         last_error = NULL, updated_at = ? WHERE delivery_id = ?`,
        [timestamp, deliveryId]
      );
      this.#appendEvent(envelope.task.taskId, "user_intervention", null, {
        action: "retry_delivery",
        deliveryId,
        previousStatus: delivery.status
      }, timestamp);
    });
    return this.getDelivery(deliveryId);
  }

  getDeliveryEnvelope(deliveryId) {
    const row = this.store.selectOne(
      `SELECT d.*, m.task_id, m.sender_agent_id, m.sender_session_id, m.recipient_session_id AS message_recipient_session_id,
              m.message_type, m.body,
              m.protocol_version, m.source_objective_id AS message_source_objective_id,
              m.target_objective_id AS message_target_objective_id,
              m.source_work_item_id AS message_source_work_item_id, m.work_item_id AS message_work_item_id,
              m.evidence_json, m.payload_json, m.error_json, m.resource_version, m.created_at AS message_created_at,
              t.context_id, t.service_id, t.type AS task_type, t.status AS task_status,
              t.initiator_agent_id, t.recipient_agent_id AS task_recipient_agent_id,
              t.initiator_session_id, t.recipient_session_id AS task_recipient_session_id,
              t.initiator_name_at_send, t.recipient_name_at_send,
              t.routing_version, t.route_status, t.routing_intent,
              t.source_objective_id, t.target_objective_id, t.source_work_item_id, t.work_item_id,
              t.iteration, t.max_iterations, t.title, t.summary,
              t.acceptance_criteria_json, a.name AS sender_agent_name,
              s.name AS service_name
       FROM collaboration_deliveries d
       JOIN collaboration_messages m ON m.message_id = d.message_id
       JOIN collaboration_tasks t ON t.task_id = m.task_id
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
        envelope: createCollaborationEnvelope({
          messageId: row.message_id,
          taskId: row.task_id,
          messageType: row.message_type,
          senderAgentId: row.sender_agent_id,
          recipientAgentId: row.recipient_agent_id,
          senderSessionId: row.sender_session_id,
          recipientSessionId: row.message_recipient_session_id,
          sourceObjectiveId: row.message_source_objective_id,
          targetObjectiveId: row.message_target_objective_id,
          sourceWorkItemId: row.message_source_work_item_id,
          workItemId: row.message_work_item_id,
          payload: parseJson(row.payload_json, {
            body: row.body,
            evidence: parseJson(row.evidence_json, []),
            resourceVersion: row.resource_version || null
          }),
          timestamp: row.message_created_at,
          error: parseJson(row.error_json, null)
        })
      },
      task: {
        taskId: row.task_id,
        contextId: row.context_id,
        initiatorAgentId: row.initiator_agent_id,
        recipientAgentId: row.task_recipient_agent_id,
        initiatorSessionId: row.initiator_session_id || null,
        recipientSessionId: row.task_recipient_session_id || null,
        initiatorNameAtSend: row.initiator_name_at_send || null,
        recipientNameAtSend: row.recipient_name_at_send || null,
        sourceObjectiveId: row.source_objective_id,
        targetObjectiveId: row.target_objective_id,
        sourceWorkItemId: row.source_work_item_id || null,
        workItemId: row.work_item_id,
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

  claimDelivery(deliveryId) {
    const timestamp = this.clock();
    this.store.db.run(
      `UPDATE collaboration_deliveries
       SET status = 'delivering', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = ?
       WHERE delivery_id = ? AND status IN ('pending', 'failed', 'queued')`,
      [timestamp, deliveryId]
    );
    if (this.store.db.getRowsModified() === 0) return null;
    this.store.scheduleSave();
    return this.getDelivery(deliveryId);
  }

  recoverInterruptedDeliveries() {
    const timestamp = this.clock();
    this.store.db.run(
      `UPDATE collaboration_deliveries
       SET status = 'failed', next_attempt_at = ?,
           last_error = COALESCE(last_error, 'Delivery interrupted by process restart.'),
           updated_at = ?
       WHERE status = 'delivering'`,
      [timestamp, timestamp]
    );
    const recovered = this.store.db.getRowsModified();
    if (recovered > 0) this.store.scheduleSave();
    return recovered;
  }

  updateDelivery(deliveryId, patch) {
    const delivery = this.getDelivery(deliveryId);
    if (!delivery) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    const status = patch.status ?? delivery.status;
    if (!DELIVERY_STATUSES.has(status)) throw domainError("INVALID_DELIVERY_STATUS", `Unsupported delivery status: ${status}`);
    const attemptCount = patch.incrementAttempt ? delivery.attemptCount + 1 : delivery.attemptCount;
    const timestamp = this.clock();
    const nextAttemptAt = Object.hasOwn(patch, "nextAttemptAt") ? patch.nextAttemptAt : delivery.nextAttemptAt;
    const targetTurnId = Object.hasOwn(patch, "targetTurnId") ? patch.targetTurnId : delivery.targetTurnId;
    const lastError = Object.hasOwn(patch, "lastError") ? patch.lastError : delivery.lastError;
    const write = () => {
      this.store.db.run(
        `UPDATE collaboration_deliveries SET status = ?, attempt_count = ?, next_attempt_at = ?,
         delivered_at = ?, target_turn_id = ?, last_error = ?, updated_at = ? WHERE delivery_id = ?`,
        [
          status, attemptCount, nextAttemptAt,
          status === "delivered" ? (patch.deliveredAt ?? timestamp) : delivery.deliveredAt,
          targetTurnId, lastError, timestamp, deliveryId
        ]
      );
      if (status === "delivered" && delivery.status !== "delivered" && patch.targetSessionId) {
        this.#establishChannel(deliveryId, patch.targetSessionId, timestamp);
        this.#closeChannelIfSettled(deliveryId, timestamp);
      }
    };
    if (status === "delivered" && delivery.status !== "delivered" && patch.targetSessionId) {
      this.#transaction(write);
    } else {
      write();
      this.store.scheduleSave();
    }
    return this.getDelivery(deliveryId);
  }

  recordDeliveryEvent(deliveryId, type, payload = {}) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    this.#transaction(() => {
      this.#appendEvent(envelope.task.taskId, type, null, {
        deliveryId,
        messageId: envelope.message.messageId,
        recipientAgentId: envelope.delivery.recipientAgentId,
        ...payload
      }, this.clock());
    });
    return this.getDelivery(deliveryId);
  }

  #isReplyEnvelope(envelope) {
    if (envelope.task.initiatorAgentId !== envelope.task.recipientAgentId) {
      return envelope.message.senderAgentId === envelope.task.recipientAgentId
        && envelope.delivery.recipientAgentId === envelope.task.initiatorAgentId;
    }
    return this.#sessionIdentityMatches(
      envelope.message.envelope.sender.sessionId,
      envelope.task.recipientSessionId
    ) && this.#sessionIdentityMatches(
      envelope.message.envelope.recipient.sessionId,
      envelope.task.initiatorSessionId
    );
  }

  #activeProviderRoute(sessionId, agentId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const providerSessionId = logical?.legacySessionId ?? sessionId;
    const session = this.store.getSession(providerSessionId);
    if ((logical && !logical.activeBinding) || session?.archived) return null;
    const bound = this.getAgentForSession(providerSessionId);
    if ((!session && !bound) || bound?.agentId !== agentId) return null;
    return {
      sessionId: logical?.logicalSessionId ?? sessionId,
      providerSessionId
    };
  }

  #establishChannel(deliveryId, targetSessionId, timestamp) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
    const targetStableId = this.#stableSessionIdentity(targetSessionId);
    const senderStableId = this.#stableSessionIdentity(envelope.message.envelope.sender.sessionId);
    if (!senderStableId || !targetStableId) {
      this.#appendEvent(envelope.task.taskId, "collaboration_channel_unavailable", null, {
        deliveryId,
        reason: "session_endpoint_missing"
      }, timestamp);
      return null;
    }
    const reply = this.#isReplyEnvelope(envelope);
    const initiatorSessionId = reply ? targetStableId : senderStableId;
    const recipientSessionId = reply ? senderStableId : targetStableId;
    const existing = this.getChannel(envelope.task.taskId);
    const initiatorRoute = this.#activeProviderRoute(initiatorSessionId, envelope.task.initiatorAgentId);
    const recipientRoute = this.#activeProviderRoute(recipientSessionId, envelope.task.recipientAgentId);
    if (!initiatorRoute || !recipientRoute) {
      if (existing?.status === "active") {
        this.store.db.run(
          `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
           invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
          ["session_endpoint_unavailable_after_delivery", timestamp, timestamp, existing.channelId]
        );
      }
      this.#appendEvent(envelope.task.taskId, "collaboration_channel_unavailable", null, {
        channelId: existing?.channelId ?? null,
        deliveryId,
        reason: "session_endpoint_unavailable_after_delivery"
      }, timestamp);
      return null;
    }
    const channelId = existing?.channelId ?? this.idFactory();
    this.store.db.run(
      `INSERT INTO collaboration_channels (
        channel_id, task_id, initiator_agent_id, recipient_agent_id,
        initiator_session_id, recipient_session_id, status,
        established_delivery_id, last_delivery_id, invalidated_reason,
        established_at, updated_at, invalidated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        initiator_agent_id=excluded.initiator_agent_id,
        recipient_agent_id=excluded.recipient_agent_id,
        initiator_session_id=excluded.initiator_session_id,
        recipient_session_id=excluded.recipient_session_id,
        status='active', last_delivery_id=excluded.last_delivery_id,
        invalidated_reason=NULL, updated_at=excluded.updated_at,
        invalidated_at=NULL, closed_at=NULL`,
      [
        channelId, envelope.task.taskId, envelope.task.initiatorAgentId, envelope.task.recipientAgentId,
        initiatorSessionId, recipientSessionId, deliveryId, deliveryId, timestamp, timestamp
      ]
    );
    this.#appendEvent(envelope.task.taskId, existing ? "collaboration_channel_updated" : "collaboration_channel_established", null, {
      channelId,
      deliveryId,
      initiatorSessionId,
      recipientSessionId
    }, timestamp);
  }

  #invalidateChannel(channelId, reason) {
    const channel = this.store.selectOne(
      "SELECT * FROM collaboration_channels WHERE channel_id = ? AND status = 'active'",
      [channelId]
    );
    if (!channel) return null;
    const timestamp = this.clock();
    this.#transaction(() => {
      this.store.db.run(
        `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
         invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
        [reason, timestamp, timestamp, channelId]
      );
      this.#appendEvent(channel.task_id, "collaboration_channel_invalidated", null, {
        channelId,
        reason
      }, timestamp);
    });
    return this.getChannel(channel.task_id);
  }

  #invalidateChannelsForSession(sessionId, reason, timestamp) {
    if (!sessionId) return;
    const channels = this.store.selectAll(
      `SELECT channel_id, task_id FROM collaboration_channels
       WHERE status='active' AND (initiator_session_id=? OR recipient_session_id=?)`,
      [sessionId, sessionId]
    );
    for (const channel of channels) {
      this.store.db.run(
        `UPDATE collaboration_channels SET status='invalid', invalidated_reason=?,
         invalidated_at=?, updated_at=? WHERE channel_id=? AND status='active'`,
        [reason, timestamp, timestamp, channel.channel_id]
      );
      this.#appendEvent(channel.task_id, "collaboration_channel_invalidated", null, {
        channelId: channel.channel_id,
        reason,
        sessionId
      }, timestamp);
    }
  }

  #closeChannelIfSettled(deliveryId, timestamp) {
    const row = this.store.selectOne(
      `SELECT t.task_id, t.status, c.channel_id,
              (SELECT COUNT(*) FROM collaboration_deliveries pending
               JOIN collaboration_messages pm ON pm.message_id=pending.message_id
               WHERE pm.task_id=t.task_id AND pending.status!='delivered') AS unsettled_count
       FROM collaboration_deliveries d
       JOIN collaboration_messages m ON m.message_id=d.message_id
       JOIN collaboration_tasks t ON t.task_id=m.task_id
       LEFT JOIN collaboration_channels c ON c.task_id=t.task_id AND c.status='active'
       WHERE d.delivery_id=?`,
      [deliveryId]
    );
    if (!row?.channel_id || !TERMINAL_TASK_STATUSES.has(row.status) || Number(row.unsettled_count) > 0) return;
    this.store.db.run(
      `UPDATE collaboration_channels SET status='closed', closed_at=?, updated_at=?
       WHERE channel_id=? AND status='active'`,
      [timestamp, timestamp, row.channel_id]
    );
    this.#appendEvent(row.task_id, "collaboration_channel_closed", null, {
      channelId: row.channel_id,
      reason: "task_terminal"
    }, timestamp);
  }

  #listTasks(column, agentId, options) {
    const conditions = [`${column} = ?`];
    const params = [agentId];
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      if (statuses.length) {
        conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    params.push(Math.max(1, Math.min(500, Number(options.limit) || 100)));
    return this.store.selectAll(
      `SELECT * FROM collaboration_tasks WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ?`,
      params
    ).map(taskFromRow);
  }

  #messageTransition(task, input) {
    const timestamp = this.clock();
    const sendsForward = task.initiatorAgentId === task.recipientAgentId
      ? this.#sessionIdentityMatches(input.options.actorSessionId, task.initiatorSessionId)
      : input.actorAgentId === task.initiatorAgentId;
    this.#transaction(() => {
      const message = this.#insertMessage({
        taskId: task.taskId,
        senderAgentId: input.actorAgentId,
        recipientAgentId: input.recipientAgentId,
        messageType: input.messageType,
        body: requiredText(input.body, "body"),
        evidence: input.options.evidence,
        resourceVersion: input.options.resourceVersion,
        idempotencyKey: optionalText(input.options.idempotencyKey),
        senderSessionId: input.options.actorSessionId,
        recipientSessionId: sendsForward ? task.recipientSessionId : task.initiatorSessionId,
        timestamp
      });
      this.#updateTaskStatus(task.taskId, input.nextStatus, timestamp, input.nextIteration);
      this.#appendEvent(task.taskId, input.eventType, input.actorAgentId, {
        from: task.status,
        to: input.nextStatus,
        iteration: input.nextIteration ?? task.iteration,
        messageId: message.messageId
      }, timestamp);
    });
    return this.getTask(task.taskId);
  }

  #transition(taskId, actorAgentId, fromStatuses, toStatus, eventType, actorRole, payload = {}, actorSessionId = null) {
    const task = this.#requireTask(taskId);
    this.#assertActor(task, actorAgentId, actorRole, actorSessionId);
    this.#assertStatus(task, fromStatuses);
    if (actorRole === "recipient") this.#refreshRecipientRoute(task);
    const timestamp = this.clock();
    this.#transaction(() => {
      this.#updateTaskStatus(taskId, toStatus, timestamp);
      this.#appendEvent(taskId, eventType, actorAgentId, { from: task.status, to: toStatus, ...payload }, timestamp);
    });
    return this.getTask(taskId);
  }

  #refreshRecipientRoute(task) {
    if (task.routeStatus === "unresolved") return;
    const logical = this.store.getLogicalSession(task.recipientSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(task.recipientSessionId);
    if (!logical?.activeBinding) {
      throw domainError("STALE_RECIPIENT_ROUTE", "The recipient Session no longer has an active Provider binding; recover it or reject the expired route.");
    }
    const binding = logical.activeBinding;
    if (Number(task.routingVersion) === Number(logical.routingVersion)
      && task.recipientBindingId === binding.bindingId) return;
    const timestamp = this.clock();
    this.store.db.run(
      `UPDATE collaboration_tasks SET routing_version=?, recipient_binding_id=?, route_status='recovered', updated_at=?
       WHERE task_id=?`,
      [logical.routingVersion, binding.bindingId, timestamp, task.taskId]
    );
    this.#appendEvent(task.taskId, "route_recovered", task.recipientAgentId, {
      previousRoutingVersion: task.routingVersion,
      routingVersion: logical.routingVersion,
      previousBindingId: task.recipientBindingId,
      recipientBindingId: binding.bindingId
    }, timestamp);
  }

  #assertRecipientRouteMetadata(task) {
    if (task.routeStatus === "unresolved") return;
    if (!task.recipientSessionId || !Number.isInteger(Number(task.routingVersion)) || Number(task.routingVersion) < 1) {
      throw domainError(
        "RECIPIENT_ROUTE_METADATA_REQUIRED",
        `Task ${task.taskId} is missing recipientSessionId or routingVersion; query the task and recover its recipient route before accept.`
      );
    }
  }

  #insertMessage(input) {
    const idempotencyKey = optionalText(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.store.selectOne(
        "SELECT * FROM collaboration_messages WHERE sender_agent_id = ? AND idempotency_key = ?",
        [input.senderAgentId, idempotencyKey]
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
              source_objective_id, target_objective_id, source_work_item_id, work_item_id
       FROM collaboration_tasks WHERE task_id = ?`,
      [input.taskId]
    );
    const sameAgent = taskScope?.initiator_agent_id === taskScope?.recipient_agent_id;
    const sendsForward = sameAgent
      ? this.#sessionIdentityMatches(input.senderSessionId, taskScope?.initiator_session_id)
      : input.senderAgentId === taskScope?.initiator_agent_id;
    const senderSessionId = this.#stableSessionIdentity(input.senderSessionId
      ?? (sendsForward ? taskScope?.initiator_session_id : taskScope?.recipient_session_id)
      ?? null);
    const recipientSessionId = this.#stableSessionIdentity(input.recipientSessionId
      ?? (sendsForward ? taskScope?.recipient_session_id : taskScope?.initiator_session_id)
      ?? null);
    const sourceObjectiveId = input.sourceObjectiveId
      ?? (sendsForward ? taskScope?.source_objective_id : taskScope?.target_objective_id);
    const targetObjectiveId = input.targetObjectiveId
      ?? (sendsForward ? taskScope?.target_objective_id : taskScope?.source_objective_id);
    const sourceWorkItemId = input.sourceWorkItemId ?? taskScope?.source_work_item_id ?? null;
    const workItemId = input.workItemId ?? taskScope?.work_item_id;
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
      sourceObjectiveId,
      targetObjectiveId,
      sourceWorkItemId,
      workItemId,
      payload,
      timestamp,
      error: input.error ?? null
    });
    this.store.db.run(
      `INSERT INTO collaboration_messages (
        message_id, task_id, protocol_version, source_objective_id, target_objective_id,
        source_work_item_id, work_item_id, sender_agent_id, recipient_agent_id,
        sender_session_id, recipient_session_id, message_type, body,
        evidence_json, payload_json, error_json, resource_version, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId, input.taskId, envelope.version, sourceObjectiveId, targetObjectiveId,
        sourceWorkItemId, workItemId, input.senderAgentId, input.recipientAgentId,
        senderSessionId, recipientSessionId, input.messageType,
        payload.body, JSON.stringify(payload.evidence), JSON.stringify(payload),
        envelope.error ? JSON.stringify(envelope.error) : null, payload.resourceVersion,
        idempotencyKey, timestamp
      ]
    );
    this.store.db.run(
      `INSERT INTO collaboration_deliveries (
        delivery_id, message_id, recipient_agent_id, status, attempt_count, next_attempt_at,
        delivered_at, target_turn_id, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      [input.deliveryId ?? this.idFactory(), messageId, input.recipientAgentId, timestamp, timestamp]
    );
    return messageFromRow(this.store.selectOne("SELECT * FROM collaboration_messages WHERE message_id = ?", [messageId]));
  }

  #insertArtifact(task, producerAgentId, input, timestamp) {
    if (task.serviceId) {
      const service = this.#requireService(task.serviceId);
      if (service.ownerAgentId !== producerAgentId) {
        throw domainError("SERVICE_OWNER_REQUIRED", `Only ${service.ownerAgentId} may publish artifacts for ${service.serviceId}.`);
      }
    }
    const artifactId = optionalText(input.artifactId) ?? this.idFactory();
    this.store.db.run(
      `INSERT INTO collaboration_artifacts (
        artifact_id, task_id, producer_agent_id, type, name, uri, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId, task.taskId, producerAgentId, requiredText(input.type, "artifact.type"),
        requiredText(input.name, "artifact.name"), requiredText(input.uri, "artifact.uri"),
        JSON.stringify(input.metadata ?? {}), timestamp
      ]
    );
    return artifactId;
  }

  #appendEvent(taskId, type, actorAgentId, payload, timestamp) {
    const row = this.store.selectOne(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM collaboration_events WHERE task_id = ?",
      [taskId]
    );
    const sequence = Number(row?.sequence ?? 0) + 1;
    this.store.db.run(
      `INSERT INTO collaboration_events (
        event_id, task_id, sequence, type, actor_agent_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.idFactory(), taskId, sequence, type, actorAgentId ?? null, JSON.stringify(payload ?? {}), timestamp ?? this.clock()]
    );
  }

  #updateTaskStatus(taskId, status, timestamp, iteration) {
    const completedAt = TERMINAL_TASK_STATUSES.has(status) ? timestamp : null;
    if (iteration == null) {
      this.store.db.run(
        "UPDATE collaboration_tasks SET status = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
        [status, timestamp, completedAt, taskId]
      );
    } else {
      this.store.db.run(
        "UPDATE collaboration_tasks SET status = ?, iteration = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
        [status, iteration, timestamp, completedAt, taskId]
      );
    }
    const artifactStatus = ["delivered", "verifying", "completed"].includes(status) ? "delivered"
      : ["rejected", "canceled", "escalated"].includes(status) ? "canceled" : "pending";
    const acceptanceStatus = status === "completed" ? "accepted"
      : status === "revision_requested" ? "revision_requested"
        : ["rejected", "canceled", "escalated"].includes(status) ? "rejected" : "pending";
    this.store.db.run(
      "UPDATE collaboration_tasks SET artifact_status = ?, acceptance_status = ? WHERE task_id = ?",
      [artifactStatus, acceptanceStatus, taskId]
    );
    const task = this.store.selectOne(
      "SELECT work_item_id FROM collaboration_tasks WHERE task_id = ?",
      [taskId]
    );
    if (task?.work_item_id) this.#syncWorkItemStatus(task.work_item_id, taskId, status, timestamp);
    if (TERMINAL_TASK_STATUSES.has(status)) {
      const unsettled = this.store.selectOne(
        `SELECT COUNT(*) AS count FROM collaboration_deliveries d
         JOIN collaboration_messages m ON m.message_id=d.message_id
         WHERE m.task_id=? AND d.status!='delivered'`,
        [taskId]
      );
      const channel = this.getChannel(taskId);
      if (channel?.status === "active" && Number(unsettled?.count ?? 0) === 0) {
        this.store.db.run(
          `UPDATE collaboration_channels SET status='closed', closed_at=?, updated_at=?
           WHERE channel_id=? AND status='active'`,
          [timestamp, timestamp, channel.channelId]
        );
        this.#appendEvent(taskId, "collaboration_channel_closed", null, {
          channelId: channel.channelId,
          reason: "task_terminal"
        }, timestamp);
      }
    }
  }

  #resolveTaskScope(input, initiator, recipient) {
    const initiatorRoute = this.#routeForSession(input.initiatorSessionId);
    const recipientRoute = this.#routeForSession(input.recipientSessionId);
    const sourceObjectiveId = initiatorRoute?.objectiveId ?? this.#resolveObjectiveForAgent(
      initiator, optionalText(input.sourceObjectiveId), "sourceObjectiveId"
    );
    const targetObjectiveId = recipientRoute?.objectiveId ?? this.#resolveObjectiveForAgent(
      recipient, optionalText(input.targetObjectiveId), "targetObjectiveId"
    );
    if (input.sourceObjectiveId && input.sourceObjectiveId !== sourceObjectiveId) {
      throw domainError("SOURCE_OBJECTIVE_SPOOFED", "sourceObjectiveId is derived from the authenticated source Session.");
    }
    if (input.targetObjectiveId && input.targetObjectiveId !== targetObjectiveId) {
      throw domainError("TARGET_OBJECTIVE_MISMATCH", "targetObjectiveId does not match the selected recipient Session.");
    }
    const sourceWorkItemId = optionalText(input.sourceWorkItemId);
    if (sourceWorkItemId) {
      const workItem = this.store.getWorkItem(sourceWorkItemId);
      if (!workItem) throw domainError("WORK_ITEM_NOT_FOUND", `WorkItem ${sourceWorkItemId} was not found.`);
      if (workItem.objective_id !== sourceObjectiveId) {
        throw domainError("WORK_ITEM_OBJECTIVE_MISMATCH", "The source WorkItem does not belong to the source Objective.");
      }
    }
    return {
      sourceObjectiveId,
      targetObjectiveId,
      sourceWorkItemId,
      routingVersion: recipientRoute?.routingVersion ?? null,
      routeStatus: recipientRoute?.routeStatus ?? "unresolved",
      initiatorBindingId: initiatorRoute?.bindingId ?? null,
      recipientBindingId: recipientRoute?.bindingId ?? null
    };
  }

  #assertSessionParticipants(input, initiator, recipient) {
    const initiatorSessionId = optionalText(input.initiatorSessionId);
    const recipientSessionId = optionalText(input.recipientSessionId);
    if (initiator.agentId === recipient.agentId
        && (!initiatorSessionId || !recipientSessionId || initiatorSessionId === recipientSessionId)) {
      throw domainError("DISTINCT_SESSIONS_REQUIRED", "Collaboration within one Agent requires two explicit, distinct Sessions.");
    }
    if (initiatorSessionId) {
      const sourceAgent = this.getAgentForSession(initiatorSessionId);
      if (sourceAgent?.agentId !== initiator.agentId) {
        throw domainError("INITIATOR_SESSION_AGENT_MISMATCH", "The selected source Session is not bound to initiatorAgentId.");
      }
    }
    if (recipientSessionId) {
      const targetAgent = this.getAgentForSession(recipientSessionId);
      if (targetAgent?.agentId !== recipient.agentId) {
        throw domainError("RECIPIENT_SESSION_AGENT_MISMATCH", "The selected target Session is not bound to recipientAgentId.");
      }
    }
  }

  #initialRecipientSessionId(input, recipient) {
    const explicit = optionalText(input.recipientSessionId);
    if (explicit) return explicit;
    // Agent-only collaboration routing deliberately starts unresolved. Objective
    // Chat is an orchestration surface, never a delivery target; the routing
    // service will bind the task to its WorkItem's Worker Session after approval.
    return optionalText(input.routingIntent) ? null : recipient.sessionId;
  }

  #routeForSession(sessionId) {
    const normalized = optionalText(sessionId);
    if (!normalized) return null;
    const logical = this.store.getLogicalSession(normalized)
      ?? this.store.getLogicalSessionByLegacySessionId(normalized);
    const session = logical?.legacySessionId
      ? this.store.getSession(logical.legacySessionId)
      : this.store.getSession(normalized);
    if (!session) throw domainError("SESSION_NOT_FOUND", `Session ${normalized} was not found.`);
    const binding = logical?.activeBinding ?? null;
    return {
      objectiveId: session.objectiveId ?? null,
      workItemId: session.workItemId ?? null,
      routingVersion: logical?.routingVersion ?? null,
      bindingId: binding?.bindingId ?? null,
      routeStatus: binding?.state === "active" ? "active" : "unresolved"
    };
  }

  #resolveObjectiveForAgent(agent, requestedObjectiveId, field) {
    const session = agent.currentSessionId ? this.store.getSession(agent.currentSessionId) : null;
    const sessionObjectiveId = session?.objectiveId ?? session?.objective_id ?? null;
    const objectiveId = requestedObjectiveId ?? sessionObjectiveId;
    if (!objectiveId) return this.#ensureCompatibilityObjective(agent).id;
    const objective = this.store.getObjective(objectiveId);
    if (!objective) throw domainError("OBJECTIVE_NOT_FOUND", `${field} ${objectiveId} was not found.`);
    const contributorIds = objective.contributorAgentIds ?? objective.contributor_agent_ids ?? [];
    const ownsWorkItem = this.store.listWorkItemsByObjective(objectiveId)
      .some((workItem) => workItem.main_agent_id === agent.agentId);
    if (sessionObjectiveId !== objectiveId && !contributorIds.includes(agent.agentId) && !ownsWorkItem) {
      throw domainError("OBJECTIVE_AGENT_NOT_AUTHORIZED", `Agent ${agent.agentId} is not assigned to Objective ${objectiveId}.`);
    }
    if (sessionObjectiveId === objectiveId && this.#isAssignableContributor(agent)) {
      this.#ensureObjectiveContributor(objectiveId, agent.agentId);
    }
    return objectiveId;
  }

  #isAssignableContributor(agent) {
    return agent.role === "independentContributor";
  }

  #ensureCompatibilityObjective(agent) {
    const id = `objective:collaboration:${encodeURIComponent(agent.agentId)}`;
    return this.store.getObjective(id) ?? this.store.createObjective({
      id,
      name: `${agent.name} collaboration boundary`,
      description: "Compatibility Objective created for collaboration from an unscoped legacy Session.",
      idealState: "All peer requests execute and close through explicit WorkItems.",
      status: "active",
      tags: ["system:collaboration-compatibility"],
      contributorAgentIds: this.#isAssignableContributor(agent) ? [agent.agentId] : []
    });
  }

  #ensureObjectiveContributor(objectiveId, agentId) {
    const objective = this.store.getObjective(objectiveId);
    if (!objective) throw domainError("OBJECTIVE_NOT_FOUND", `Objective ${objectiveId} was not found.`);
    if (objective.contributorAgentIds.includes(agentId)) return objective;
    return this.store.updateObjective(objectiveId, {
      contributorAgentIds: [...objective.contributorAgentIds, agentId]
    });
  }

  #validateRequestedWorkItem(workItemId, targetObjectiveId, recipientAgentId) {
    const workItem = this.store.getWorkItem(workItemId);
    if (!workItem) throw domainError("WORK_ITEM_NOT_FOUND", `WorkItem ${workItemId} was not found.`);
    if (workItem.objective_id !== targetObjectiveId) {
      throw domainError("WORK_ITEM_OBJECTIVE_MISMATCH", "The collaboration WorkItem must belong to the target Objective.");
    }
    if (recipientAgentId && workItem.main_agent_id && workItem.main_agent_id !== recipientAgentId) {
      throw domainError("WORK_ITEM_AGENT_MISMATCH", `WorkItem ${workItemId} is assigned to another Agent.`);
    }
    if (["done", "complete", "completed", "canceled", "cancelled"].includes(workItem.status)) {
      throw domainError("WORK_ITEM_TERMINAL", `WorkItem ${workItemId} is already terminal.`);
    }
    return workItem;
  }

  #ensureCollaborationWorkItem(input) {
    if (input.requestedWorkItemId) {
      const existing = this.#validateRequestedWorkItem(
        input.requestedWorkItemId,
        input.targetObjectiveId,
        input.recipientAgentId
      );
      if (input.recipientAgentId && !existing.main_agent_id) {
        return this.store.updateWorkItem(existing.id, { mainAgentId: input.recipientAgentId });
      }
      return existing;
    }
    const id = `work_item:collaboration:${input.taskId}`;
    return this.store.getWorkItem(id) ?? this.store.createWorkItem({
      id,
      objectiveId: input.targetObjectiveId,
      title: input.title,
      description: input.summary,
      acceptanceCriteria: input.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n"),
      priority: "medium",
      status: input.status ?? "todo",
      mainWorkspaceId: this.#defaultCollaborationWorkspace(input.targetObjectiveId),
      mainAgentId: input.recipientAgentId
    });
  }

  #defaultCollaborationWorkspace(objectiveId) {
    const objective = this.store.getObjective(objectiveId);
    return (objective?.workspaceIds ?? []).find((repositoryId) => this.store.getGitRepository(repositoryId)) ?? null;
  }

  #syncWorkItemStatus(workItemId, taskId, taskStatus, timestamp) {
    const status = taskStatus === "completed"
      ? "done"
      : ["rejected", "canceled", "escalated"].includes(taskStatus)
        ? "canceled"
        : ["working", "delivered", "verifying", "revision_requested"].includes(taskStatus)
          ? "in_progress"
          : "todo";
    const executionStatus = taskStatus === "working" || taskStatus === "revision_requested"
      ? "running"
      : taskStatus === "completed"
        ? "completed"
        : ["rejected", "canceled", "escalated"].includes(taskStatus)
          ? "failed"
          : taskStatus === "delivered" || taskStatus === "verifying"
            ? "awaiting_acceptance"
            : "idle";
    const patch = { status, executionStatus };
    if (taskStatus === "completed") {
      patch.acceptanceAssessment = {
        status: "passed",
        source: "collaboration",
        collaborationTaskId: taskId,
        assessedAt: timestamp
      };
    }
    this.store.updateWorkItem(workItemId, patch);
  }

  #migrateLegacyCollaborationTasks() {
    const migrationId = "collaboration-objective-work-item-v2";
    if (!this.store.db) {
      return { status: "deferred", migrationId, migratedTaskCount: 0 };
    }
    if (this.store.selectOne(
      "SELECT migration_id FROM data_migrations WHERE migration_id = ?",
      [migrationId]
    )) {
      return { status: "already-applied", migrationId, migratedTaskCount: 0 };
    }
    const rows = this.store.selectAll(
      `SELECT * FROM collaboration_tasks
       WHERE protocol_version <> ? OR source_objective_id IS NULL OR target_objective_id IS NULL OR work_item_id IS NULL`,
      [COLLABORATION_PROTOCOL_VERSION]
    );
    this.store.db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const row of rows) {
        const initiator = this.#requireAgent(row.initiator_agent_id);
        const recipient = this.#requireAgent(row.recipient_agent_id);
        const sourceObjectiveId = this.#objectiveForSession(row.initiator_session_id)
          ?? this.#ensureCompatibilityObjective(initiator).id;
        let targetObjectiveId = this.#objectiveForSession(row.recipient_session_id)
          ?? this.#ensureCompatibilityObjective(recipient).id;
        if (targetObjectiveId === sourceObjectiveId) {
          targetObjectiveId = this.#ensureCompatibilityObjective(recipient).id;
        }
        if (this.#isAssignableContributor(initiator)) {
          this.#ensureObjectiveContributor(sourceObjectiveId, initiator.agentId);
        }
        if (this.#isAssignableContributor(recipient)) {
          this.#ensureObjectiveContributor(targetObjectiveId, recipient.agentId);
        }
        const workItem = this.#ensureCollaborationWorkItem({
          requestedWorkItemId: row.work_item_id,
          taskId: row.task_id,
          targetObjectiveId,
          recipientAgentId: this.#isAssignableContributor(recipient) ? recipient.agentId : null,
          title: row.title,
          summary: row.summary,
          acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
          status: this.#workItemStatusForTask(row.status)
        });
        this.store.db.run(
          `UPDATE collaboration_tasks SET protocol_version = ?, source_objective_id = ?,
           target_objective_id = ?, work_item_id = ? WHERE task_id = ?`,
          [COLLABORATION_PROTOCOL_VERSION, sourceObjectiveId, targetObjectiveId, workItem.id, row.task_id]
        );
        const messages = this.store.selectAll(
          "SELECT * FROM collaboration_messages WHERE task_id = ? ORDER BY created_at, message_id",
          [row.task_id]
        );
        for (const message of messages) {
          const forward = message.sender_agent_id === row.initiator_agent_id;
          const messageSourceObjectiveId = forward ? sourceObjectiveId : targetObjectiveId;
          const messageTargetObjectiveId = forward ? targetObjectiveId : sourceObjectiveId;
          const payload = {
            body: message.body,
            evidence: parseJson(message.evidence_json, []),
            resourceVersion: message.resource_version || null
          };
          const envelope = createCollaborationEnvelope({
            messageId: message.message_id,
            taskId: row.task_id,
            messageType: message.message_type,
            senderAgentId: message.sender_agent_id,
            recipientAgentId: message.recipient_agent_id,
            senderSessionId: forward ? row.initiator_session_id : row.recipient_session_id,
            recipientSessionId: forward ? row.recipient_session_id : row.initiator_session_id,
            sourceObjectiveId: messageSourceObjectiveId,
            targetObjectiveId: messageTargetObjectiveId,
            sourceWorkItemId: row.source_work_item_id || null,
            workItemId: workItem.id,
            payload,
            timestamp: message.created_at,
            error: parseJson(message.error_json, null)
          });
          this.store.db.run(
            `UPDATE collaboration_messages SET protocol_version = ?, source_objective_id = ?,
             target_objective_id = ?, source_work_item_id = ?, work_item_id = ?, payload_json = ?, error_json = ?
             WHERE message_id = ?`,
            [
              envelope.version, messageSourceObjectiveId, messageTargetObjectiveId,
              row.source_work_item_id || null, workItem.id, JSON.stringify(payload),
              envelope.error ? JSON.stringify(envelope.error) : null, message.message_id
            ]
          );
        }
        this.#syncWorkItemStatus(workItem.id, row.task_id, row.status, row.updated_at);
      }
      this.store.db.run(
        "INSERT INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
        [migrationId, new Date().toISOString()]
      );
      this.store.db.run("COMMIT");
      this.store.scheduleSave();
      return { status: "applied", migrationId, migratedTaskCount: rows.length };
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
  }

  #recordChannelSchemaMigration() {
    const migrationId = "collaboration-session-channels-v1";
    this.store.db.run(
      "INSERT OR IGNORE INTO data_migrations (migration_id, applied_at) VALUES (?, ?)",
      [migrationId, this.clock()]
    );
    if (this.store.db.getRowsModified() > 0) this.store.scheduleSave();
  }

  #objectiveForSession(sessionId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId);
    const session = this.store.getSession(sessionId)
      ?? (logical?.legacySessionId ? this.store.getSession(logical.legacySessionId) : null);
    const objectiveId = session?.objectiveId ?? session?.objective_id ?? null;
    return objectiveId && this.store.getObjective(objectiveId) ? objectiveId : null;
  }

  #workItemStatusForTask(taskStatus) {
    if (taskStatus === "completed") return "done";
    if (["rejected", "canceled", "escalated"].includes(taskStatus)) return "canceled";
    if (["working", "delivered", "verifying", "revision_requested"].includes(taskStatus)) return "in_progress";
    return "todo";
  }

  #assertActor(task, actorAgentId, role, actorSessionId = null) {
    const expected = role === "initiator" ? task.initiatorAgentId : task.recipientAgentId;
    if (actorAgentId !== expected) {
      throw domainError("ACTOR_NOT_AUTHORIZED", `Only the task ${role} (${expected}) may perform this action.`);
    }
    const expectedSessionId = role === "initiator" ? task.initiatorSessionId : task.recipientSessionId;
    const exactSessionRequired = task.initiatorAgentId === task.recipientAgentId;
    if ((exactSessionRequired || (actorSessionId && expectedSessionId))
      && !this.#sessionIdentityMatches(actorSessionId, expectedSessionId)) {
      throw domainError("SESSION_ACTOR_MISMATCH", `This action belongs to the task ${role} Session ${expectedSessionId}.`);
    }
  }

  #sessionIdentityMatches(actualSessionId, expectedSessionId) {
    if (!actualSessionId || !expectedSessionId) return false;
    const actual = this.store.getLogicalSession(actualSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(actualSessionId);
    const expected = this.store.getLogicalSession(expectedSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(expectedSessionId);
    return (actual?.logicalSessionId ?? actualSessionId) === (expected?.logicalSessionId ?? expectedSessionId);
  }

  #stableSessionIdentity(sessionId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    return logical?.logicalSessionId ?? sessionId;
  }

  #assertStatus(task, expected) {
    if (!expected.includes(task.status)) {
      throw domainError("INVALID_TASK_TRANSITION", `Task ${task.taskId} is ${task.status}; expected ${expected.join(" or ")}.`);
    }
  }

  #requireAgent(agentId) {
    const agent = this.getAgent(requiredId(agentId, "agentId"));
    if (!agent) throw domainError("AGENT_NOT_FOUND", `Agent ${agentId} was not found.`);
    return agent;
  }

  #requireService(serviceId) {
    const service = this.getService(requiredId(serviceId, "serviceId"));
    if (!service) throw domainError("SERVICE_NOT_FOUND", `Service ${serviceId} was not found.`);
    return service;
  }

  #requireTask(taskId) {
    const task = this.getTask(requiredId(taskId, "taskId"));
    if (!task) throw domainError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    return task;
  }

  #transaction(run) {
    this.store.db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = run();
      this.store.db.run("COMMIT");
      this.store.scheduleSave();
      return result;
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
  }
}

function agentFromRow(row, store, sessionReference = null) {
  const selectedSessionId = typeof sessionReference === "string"
    ? sessionReference
    : sessionReference?.logicalSessionId ?? sessionReference?.legacySessionId ?? row.current_session_id;
  const logical = selectedSessionId
    ? (store.getLogicalSession(selectedSessionId) ?? store.getLogicalSessionByLegacySessionId(selectedSessionId))
    : null;
  const selectedProviderSessionId = logical?.legacySessionId ?? selectedSessionId;
  const selectedSession = selectedProviderSessionId ? store.getSession(selectedProviderSessionId) : null;
  const currentSession = row.current_session_id ? store.getSession(row.current_session_id) : null;
  const objectiveIds = store.listObjectives()
    .filter((objective) => (objective.contributorAgentIds ?? []).includes(row.agent_id))
    .map((objective) => objective.id);
  return {
    agentId: row.agent_id,
    name: row.name,
    sessionName: logical?.sessionName ?? selectedSession?.title ?? null,
    sessionId: logical?.logicalSessionId ?? selectedSession?.id ?? null,
    providerSessionId: selectedSession?.id ?? null,
    description: row.description,
    role: row.role,
    agentKind: row.agent_kind ?? "user",
    systemPrompt: row.system_prompt ?? "",
    status: "available",
    capabilities: parseJson(row.capabilities_json, []),
    currentSessionId: row.current_session_id || null,
    currentObjectiveId: currentSession?.objectiveId ?? null,
    currentWorkItemId: currentSession?.workItemId ?? null,
    objectiveIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serviceFromRow(row) {
  return {
    serviceId: row.service_id,
    name: row.name,
    description: row.description,
    ownerAgentId: row.owner_agent_id,
    currentVersion: row.current_version || null,
    status: row.status,
    endpoint: row.endpoint || null,
    repositoryRoot: row.repository_root || null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function taskFromRow(row) {
  return {
    taskId: row.task_id,
    contextId: row.context_id,
    parentTaskId: row.parent_task_id || null,
    protocolVersion: row.protocol_version,
    sourceObjectiveId: row.source_objective_id,
    targetObjectiveId: row.target_objective_id,
    sourceWorkItemId: row.source_work_item_id || null,
    workItemId: row.work_item_id,
    initiatorAgentId: row.initiator_agent_id,
    recipientAgentId: row.recipient_agent_id,
    initiatorSessionId: row.initiator_session_id || null,
    recipientSessionId: row.recipient_session_id || null,
    initiatorNameAtSend: row.initiator_name_at_send || null,
    recipientNameAtSend: row.recipient_name_at_send || null,
    routingVersion: row.routing_version == null ? null : Number(row.routing_version),
    routeStatus: row.route_status || "unresolved",
    routingIntent: row.routing_intent || null,
    artifactStatus: row.artifact_status || "pending",
    acceptanceStatus: row.acceptance_status || "pending",
    initiatorBindingId: row.initiator_binding_id || null,
    recipientBindingId: row.recipient_binding_id || null,
    serviceId: row.service_id || null,
    type: row.type,
    status: row.status,
    iteration: Number(row.iteration),
    maxIterations: Number(row.max_iterations),
    title: row.title,
    summary: row.summary,
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
    idempotencyKey: row.idempotency_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

function messageFromRow(row) {
  const payload = parseJson(row.payload_json, {
    body: row.body,
    evidence: parseJson(row.evidence_json, []),
    resourceVersion: row.resource_version || null
  });
  const error = parseJson(row.error_json, null);
  const envelope = createCollaborationEnvelope({
    messageId: row.message_id,
    taskId: row.task_id,
    messageType: row.message_type,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    senderSessionId: row.sender_session_id,
    recipientSessionId: row.recipient_session_id,
    sourceObjectiveId: row.source_objective_id,
    targetObjectiveId: row.target_objective_id,
    sourceWorkItemId: row.source_work_item_id,
    workItemId: row.work_item_id,
    payload,
    timestamp: row.created_at,
    error
  });
  return {
    messageId: row.message_id,
    taskId: row.task_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    senderSessionId: row.sender_session_id || null,
    recipientSessionId: row.recipient_session_id || null,
    messageType: row.message_type,
    body: row.body,
    evidence: parseJson(row.evidence_json, []),
    resourceVersion: row.resource_version || null,
    idempotencyKey: row.idempotency_key || null,
    createdAt: row.created_at,
    envelope
  };
}

function artifactFromRow(row) {
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    producerAgentId: row.producer_agent_id,
    type: row.type,
    name: row.name,
    uri: row.uri,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

function eventFromRow(row) {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    type: row.type,
    actorAgentId: row.actor_agent_id || null,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

function deliveryFromRow(row) {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    recipientAgentId: row.recipient_agent_id,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at || null,
    deliveredAt: row.delivered_at || null,
    targetTurnId: row.target_turn_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function channelFromRow(row) {
  return {
    channelId: row.channel_id,
    taskId: row.task_id,
    initiatorAgentId: row.initiator_agent_id,
    recipientAgentId: row.recipient_agent_id,
    initiatorSessionId: row.initiator_session_id,
    recipientSessionId: row.recipient_session_id,
    status: row.status,
    establishedDeliveryId: row.established_delivery_id,
    lastDeliveryId: row.last_delivery_id,
    invalidatedReason: row.invalidated_reason || null,
    establishedAt: row.established_at,
    updatedAt: row.updated_at,
    invalidatedAt: row.invalidated_at || null,
    closedAt: row.closed_at || null
  };
}

function taskConfirmationFromRow(row, core) {
  const request = parseJson(row.request_json, {});
  const presentation = request.presentation ?? {};
  const initiator = core.getAgent(row.initiator_agent_id);
  const recipient = core.getAgent(row.recipient_agent_id);
  const recipientRouteUnresolved = Boolean(request.routingIntent) && !row.recipient_session_id;
  return {
    confirmationId: row.confirmation_id,
    initiatorAgentId: row.initiator_agent_id,
    initiatorSessionId: row.initiator_session_id || initiator?.sessionId || null,
    initiatorAgentName: presentation.initiatorAgentName || initiator?.name || row.initiator_agent_id,
    initiatorSessionTitle: presentation.initiatorSession?.title || row.initiator_name_at_send || null,
    initiatorSessionKind: presentation.initiatorSession?.sessionKind || null,
    initiatorWorkItemId: presentation.initiatorSession?.workItemId || request.sourceWorkItemId || null,
    recipientAgentId: row.recipient_agent_id,
    recipientSessionId: row.recipient_session_id || (recipientRouteUnresolved ? null : recipient?.sessionId) || null,
    recipientAgentName: presentation.recipientAgentName || recipient?.name || row.recipient_agent_id,
    recipientSessionTitle: presentation.recipientSession?.title || row.recipient_name_at_send || null,
    recipientSessionKind: presentation.recipientSession?.sessionKind || null,
    recipientWorkItemId: presentation.recipientSession?.workItemId || request.workItemId || null,
    sourceObjectiveId: presentation.sourceObjective?.id || request.sourceObjectiveId || null,
    sourceObjectiveName: presentation.sourceObjective?.name || request.sourceObjectiveId || null,
    targetObjectiveId: presentation.targetObjective?.id || request.targetObjectiveId || null,
    targetObjectiveName: presentation.targetObjective?.name || request.targetObjectiveId || null,
    sourceSessionId: row.source_session_id || null,
    sourceTurnId: row.source_turn_id || null,
    request,
    status: row.status,
    taskId: row.task_id || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

function sessionPresentationSnapshot(store, sessionId) {
  if (!sessionId) return null;
  const logical = store.getLogicalSession(sessionId) ?? store.getLogicalSessionByLegacySessionId(sessionId);
  const providerSessionId = logical?.legacySessionId ?? sessionId;
  const session = store.getSession(providerSessionId);
  if (!session) return null;
  return {
    id: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id,
    title: logical?.sessionName ?? session.title,
    sessionKind: session.sessionKind,
    workItemId: session.workItemId ?? null
  };
}

function requiredId(value, field) {
  const text = requiredText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw domainError("INVALID_ID", `${field} contains unsupported characters.`);
  }
  return text;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw domainError("VALIDATION_ERROR", `${field} is required.`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertKnownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw domainError("INVALID_INPUT", "Collaboration task input must be an object.");
  }
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw domainError("UNKNOWN_FIELD", `Unknown collaboration task field: ${unknown}.`);
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
}

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw domainError("VALIDATION_ERROR", "maxIterations must be a positive integer.");
  }
  return number;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
