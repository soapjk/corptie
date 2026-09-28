import { randomUUID } from "node:crypto";
import { CollaborationAgentDirectory } from "./collaborationAgentDirectory.mjs";
import { CollaborationRecordWriter } from "./collaborationRecordWriter.mjs";
import { CollaborationTaskScope } from "./collaborationTaskScope.mjs";
import { CollaborationDeliveryReader } from "./collaborationDeliveryReader.mjs";
import { CollaborationTaskChannels } from "./collaborationTaskChannels.mjs";
import { CollaborationServiceDirectory } from "./collaborationServiceDirectory.mjs";
import { requiredId, requiredText, optionalText, assertKnownFields, stringList, positiveInteger, domainError } from "./collaborationValidation.mjs";
import { migrateCollaborationProtocol } from "./collaborationProtocolMigrations.mjs";
import {
  taskFromRow,
  messageFromRow,
  artifactFromRow,
  eventFromRow,
  deliveryFromRow,
  taskConfirmationFromRow,
  sessionPresentationSnapshot
} from "./collaborationRecordProjection.mjs";
import {
  COLLABORATION_PROTOCOL_VERSION
} from "./collaborationProtocol.mjs";

const TERMINAL_TASK_STATUSES = new Set(["completed", "rejected", "canceled", "escalated"]);
const DELIVERY_STATUSES = new Set(["pending", "queued", "delivering", "delivered", "failed"]);
const TASK_INPUT_FIELDS = new Set([
  "taskId", "confirmationId", "initiatorAgentId", "recipientAgentId", "sessionAgentId", "recipientSessionName",
  "serviceId", "type", "title", "summary", "acceptanceCriteria", "evidence", "resourceVersion",
  "maxIterations", "idempotencyKey", "messageIdempotencyKey", "parentTaskId", "contextId",
  "contextTitle", "contextMetadata", "messageId", "deliveryId", "sourceSessionId", "sourceTurnId",
  "initiatorSessionId", "recipientSessionId", "initiatorNameAtSend", "recipientNameAtSend",
  "sourceWorkId", "targetWorkId", "sourceTaskId", "targetTaskId",
  "routingVersion", "routeStatus", "initiatorBindingId", "recipientBindingId", "routingIntent",
  "presentation"
]);

export class CollaborationCore {
  constructor(store, options = {}) {
    this.store = store;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.serviceDirectory = new CollaborationServiceDirectory({
      store, clock: () => this.clock(), requireAgent: (agentId) => this.#requireAgent(agentId)
    });
    this.taskChannels = new CollaborationTaskChannels({
      store, clock: () => this.clock(), idFactory: () => this.idFactory(),
      terminalTaskStatuses: TERMINAL_TASK_STATUSES,
      getDeliveryEnvelope: (id) => this.getDeliveryEnvelope(id),
      getAgentForSession: (id) => this.getAgentForSession(id),
      sessionIdentityMatches: (...args) => this.#sessionIdentityMatches(...args),
      stableSessionIdentity: (...args) => this.#stableSessionIdentity(...args),
      appendEvent: (...args) => this.#appendEvent(...args),
      transaction: (...args) => this.#transaction(...args),
    });
    this.deliveryReader = new CollaborationDeliveryReader({
      store, clock: () => this.clock(), listArtifacts: (taskId) => this.listArtifacts(taskId)
    });
    this.taskScope = new CollaborationTaskScope({
      store,
      stableSessionIdentity: (id) => this.#stableSessionIdentity(id),
      getAgentForSession: (id) => this.getAgentForSession(id)
    });
    this.recordWriter = new CollaborationRecordWriter({
      store, clock: () => this.clock(), idFactory: () => this.idFactory(),
      stableSessionIdentity: (id) => this.#stableSessionIdentity(id),
      sessionIdentityMatches: (actual, expected) => this.#sessionIdentityMatches(actual, expected),
      requireService: (id) => this.#requireService(id)
    });
    this.agentDirectory = new CollaborationAgentDirectory({
      store, clock: () => this.clock(), idFactory: () => this.idFactory(),
      requireAgent: (...args) => this.#requireAgent(...args),
      transaction: (...args) => this.#transaction(...args),
      stableSessionIdentity: (...args) => this.#stableSessionIdentity(...args),
      invalidateChannelsForSession: (...args) => this.#invalidateChannelsForSession(...args),
    });
    this.initialize();
  }

  initialize() {
    return migrateCollaborationProtocol({
      store: this.store,
      clock: () => this.clock(),
      requireAgent: (...args) => this.#requireAgent(...args),
      workForSession: (...args) => this.#workForSession(...args),
      ensureCompatibilityWork: (...args) => this.#ensureCompatibilityWork(...args),
      isAssignableContributor: (...args) => this.#isAssignableContributor(...args),
      ensureWorkContributor: (...args) => this.#ensureWorkContributor(...args),
      ensureCollaborationTask: (...args) => this.#ensureCollaborationTask(...args),
      syncTaskStatus: (...args) => this.#syncTaskStatus(...args),
    });
  }

  registerAgent(...args) { return this.agentDirectory.registerAgent(...args); }
  getAgent(...args) { return this.agentDirectory.getAgent(...args); }
  getAgentForSession(...args) { return this.agentDirectory.getAgentForSession(...args); }
  resolveAgentBySessionName(...args) { return this.agentDirectory.resolveAgentBySessionName(...args); }
  listAgents(...args) { return this.agentDirectory.listAgents(...args); }
  bindSession(...args) { return this.agentDirectory.bindSession(...args); }
  unbindSession(...args) { return this.agentDirectory.unbindSession(...args); }
  detachSession(...args) { return this.agentDirectory.detachSession(...args); }
  detachMissingSessionBindings(...args) { return this.agentDirectory.detachMissingSessionBindings(...args); }

  registerService(input) { return this.serviceDirectory.registerService(input); }
  updateService(serviceId, actorAgentId, patch = {}) { return this.serviceDirectory.updateService(serviceId, actorAgentId, patch); }
  getService(serviceId) { return this.serviceDirectory.getService(serviceId); }
  listServices(options = {}) { return this.serviceDirectory.listServices(options); }
  addServiceConsumer(serviceId, agentId) { return this.serviceDirectory.addServiceConsumer(serviceId, agentId); }
  listServiceConsumers(serviceId) { return this.serviceDirectory.listServiceConsumers(serviceId); }

  createTask(input) {
    assertKnownFields(input, TASK_INPUT_FIELDS);
    const initiator = this.#requireAgent(input.initiatorAgentId);
    const recipient = this.#requireAgent(input.recipientAgentId);
    this.#assertSessionParticipants(input, initiator, recipient, { requireRecipient: true });
    const initiatorSessionId = this.#stableSessionIdentity(requiredId(input.initiatorSessionId, "initiatorSessionId"));
    const recipientSessionId = this.#stableSessionIdentity(requiredId(input.recipientSessionId, "recipientSessionId"));
    const taskType = input.type ?? "change_request";
    if (!["question", "change_request"].includes(taskType)) {
      throw domainError("INVALID_TASK_TYPE", `Unsupported task type: ${taskType}`);
    }
    const idempotencyKey = optionalText(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.store.selectOne(
        "SELECT task_id FROM collaboration_requests WHERE initiator_session_id = ? AND idempotency_key = ?",
        [initiatorSessionId, idempotencyKey]
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
      const task = this.#ensureCollaborationTask({
        requestedTaskId: input.targetTaskId ?? scope.targetTaskId,
        taskId,
        targetWorkId: scope.targetWorkId,
        recipientAgentId: recipient.agentId,
        title,
        summary,
        acceptanceCriteria,
        lifecycleState: "todo"
      });
      this.store.db.run(
        `INSERT OR IGNORE INTO collaboration_contexts (
          context_id, title, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [contextId, optionalText(input.contextTitle) ?? title, JSON.stringify(input.contextMetadata ?? {}), timestamp, timestamp]
      );
      this.store.db.run(
        `INSERT INTO collaboration_requests (
          task_id, context_id, parent_task_id, protocol_version,
          source_work_id, target_work_id, source_task_id, target_task_id,
          initiator_agent_id, recipient_agent_id, service_id,
          type, status, iteration, max_iterations, title, summary, acceptance_criteria_json,
          idempotency_key, created_at, updated_at, completed_at,
          initiator_session_id, recipient_session_id, initiator_name_at_send, recipient_name_at_send,
          routing_version, route_status, routing_intent, artifact_status, acceptance_status,
          initiator_binding_id, recipient_binding_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`,
        [
          taskId, contextId, optionalText(input.parentTaskId), COLLABORATION_PROTOCOL_VERSION,
          scope.sourceWorkId, scope.targetWorkId, scope.sourceTaskId, task.id,
          initiator.agentId, recipient.agentId, service?.serviceId ?? null, taskType,
          maxIterations, title, summary, JSON.stringify(acceptanceCriteria), idempotencyKey, timestamp, timestamp,
          initiatorSessionId,
          recipientSessionId,
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
      this.store.db.run(
        `INSERT INTO collaboration_session_participants (task_id, session_id, role, created_at)
         VALUES (?, ?, 'initiator', ?), (?, ?, 'recipient', ?)`,
        [taskId, initiatorSessionId, timestamp, taskId, recipientSessionId, timestamp]
      );
      this.#insertMessage({
        messageId,
        taskId,
        senderAgentId: initiator.agentId,
        recipientAgentId: recipient.agentId,
        sourceWorkId: scope.sourceWorkId,
        targetWorkId: scope.targetWorkId,
        sourceTaskId: scope.sourceTaskId,
        targetTaskId: task.id,
        messageType: taskType,
        body: summary,
        evidence: input.evidence,
        resourceVersion: input.resourceVersion,
        idempotencyKey: optionalText(input.messageIdempotencyKey),
        deliveryId,
        senderSessionId: initiatorSessionId,
        recipientSessionId,
        timestamp
      });
      this.#appendEvent(taskId, "task_created", initiator.agentId, {
        status: "proposed",
        messageId,
        recipientAgentId: recipient.agentId,
        sourceWorkId: scope.sourceWorkId,
        targetWorkId: scope.targetWorkId,
        targetTaskId: task.id
      }, timestamp, initiatorSessionId);
    });
    return this.getTask(taskId);
  }

  proposeTask(input) {
    assertKnownFields(input, TASK_INPUT_FIELDS);
    const initiator = this.#requireAgent(input.initiatorAgentId);
    const recipient = this.#requireAgent(input.recipientAgentId);
    this.#assertSessionParticipants(input, initiator, recipient, { requireRecipient: false });
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
    if (input.targetTaskId) {
      this.#validateRequestedTask(input.targetTaskId, scope.targetWorkId, recipient.agentId);
    }
    const initiatorSessionId = input.initiatorSessionId ?? initiator.sessionId;
    const recipientSessionId = this.#initialRecipientSessionId(input, recipient);
    const initiatorSession = sessionPresentationSnapshot(this.store, initiatorSessionId);
    const recipientSession = sessionPresentationSnapshot(this.store, recipientSessionId);
    const sourceWork = this.store.getWork(scope.sourceWorkId);
    const targetWork = this.store.getWork(scope.targetWorkId);
    const request = {
      ...input,
      initiatorAgentId: initiator.agentId,
      recipientAgentId: recipient.agentId,
      initiatorSessionId,
      recipientSessionId,
      initiatorNameAtSend: input.initiatorNameAtSend ?? initiatorSession?.title ?? initiator.sessionName,
      recipientNameAtSend: input.recipientNameAtSend ?? recipientSession?.title
        ?? (recipientSessionId ? recipient.sessionName : null),
      sourceWorkId: scope.sourceWorkId,
      targetWorkId: scope.targetWorkId,
      sourceTaskId: scope.sourceTaskId,
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
      sourceWork: { id: scope.sourceWorkId, name: sourceWork?.name ?? scope.sourceWorkId },
      targetWork: { id: scope.targetWorkId, name: targetWork?.name ?? scope.targetWorkId },
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

  hasConfirmedSessionRoute(initiatorSessionId, recipientSessionId) {
    const sourceSessionId = optionalText(initiatorSessionId);
    const targetSessionId = optionalText(recipientSessionId);
    if (!sourceSessionId || !targetSessionId) return false;
    const currentGrant = this.store.selectOne(
      `SELECT confirmation_id FROM collaboration_request_confirmations
       WHERE initiator_session_id = ? AND recipient_session_id = ?
         AND status = 'confirmed' AND task_id IS NOT NULL
       ORDER BY resolved_at DESC LIMIT 1`,
      [sourceSessionId, targetSessionId]
    );
    if (currentGrant) return true;
    return Boolean(this.store.selectOne(
      `SELECT confirmation.confirmation_id
       FROM collaboration_request_confirmations confirmation
       JOIN collaboration_requests task ON task.task_id = confirmation.task_id
       WHERE (confirmation.recipient_session_id IS NULL OR confirmation.recipient_session_id = '')
         AND COALESCE(NULLIF(confirmation.initiator_session_id, ''), task.initiator_session_id) = ?
         AND task.recipient_session_id = ?
         AND confirmation.status = 'confirmed'
       ORDER BY confirmation.resolved_at DESC LIMIT 1`,
      [sourceSessionId, targetSessionId]
    ));
  }

  discardPendingTaskConfirmation(confirmationId) {
    const confirmation = this.getTaskConfirmation(confirmationId);
    if (!confirmation) return false;
    if (confirmation.status !== "pending" || confirmation.taskId) {
      throw domainError(
        "CONFIRMATION_NOT_DISCARDABLE",
        "Only a pending collaboration confirmation without a Task may be discarded after staging fails."
      );
    }
    this.store.db.run(
      "DELETE FROM collaboration_request_confirmations WHERE confirmation_id = ? AND status = 'pending' AND task_id IS NULL",
      [confirmationId]
    );
    this.store.scheduleSave();
    return true;
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

  confirmTaskConfirmation(confirmationId, resolution = {}) {
    const confirmation = this.getTaskConfirmation(confirmationId);
    if (!confirmation) throw domainError("CONFIRMATION_NOT_FOUND", "Collaboration confirmation was not found.");
    if (confirmation.status === "confirmed") return confirmation;
    if (confirmation.status !== "pending") throw domainError("CONFIRMATION_ALREADY_RESOLVED", "Collaboration confirmation was already rejected.");
    const task = this.createTask({
      ...confirmation.request,
      recipientAgentId: resolution.recipientAgentId ?? confirmation.request.recipientAgentId,
      recipientSessionId: resolution.recipientSessionId ?? confirmation.request.recipientSessionId,
      taskId: confirmation.request.taskId,
      targetTaskId: resolution.targetTaskId ?? confirmation.request.targetTaskId,
      recipientNameAtSend: resolution.recipientNameAtSend ?? confirmation.request.recipientNameAtSend,
      idempotencyKey: confirmation.request.idempotencyKey ?? `confirmation:${confirmation.confirmationId}`
    });
    this.store.db.run(
      `UPDATE collaboration_request_confirmations
       SET status = 'confirmed', task_id = ?, resolved_at = ?,
           initiator_session_id = ?, recipient_session_id = ?,
           initiator_name_at_send = ?, recipient_name_at_send = ?
       WHERE confirmation_id = ? AND status = 'pending'`,
      [
        task.taskId, this.clock(), task.initiatorSessionId, task.recipientSessionId,
        task.initiatorNameAtSend, task.recipientNameAtSend, confirmationId
      ]
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
    const row = this.store.selectOne("SELECT * FROM collaboration_requests WHERE task_id = ?", [taskId]);
    if (!row) return null;
    return {
      ...taskFromRow(row, this.store),
      messages: this.listMessages(taskId),
      artifacts: this.listArtifacts(taskId),
      events: this.listEvents(taskId)
    };
  }

  getTaskForTask(taskId) {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) return null;
    const row = this.store.selectOne(
      `SELECT task_id FROM collaboration_requests
       WHERE target_task_id = ?
       ORDER BY created_at DESC, task_id DESC
       LIMIT 1`,
      [id]
    );
    return row ? this.getTask(row.task_id) : null;
  }

  hasTask(taskId) {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) return false;
    return Boolean(this.store.selectOne(
      "SELECT 1 FROM collaboration_requests WHERE task_id = ?",
      [id]
    ));
  }

  getChannel(taskId) { return this.taskChannels.getChannel(taskId); }
  resolveDirectReplyRoute(deliveryId) { return this.taskChannels.resolveDirectReplyRoute(deliveryId); }

  rerouteTaskRecipient(taskId, recipientSessionId, details = {}) {
    const task = this.#requireTask(taskId);
    if (task.protocolVersion === COLLABORATION_PROTOCOL_VERSION) {
      throw domainError(
        "IMMUTABLE_RECIPIENT_SESSION",
        "Protocol v3 collaboration Tasks cannot be rerouted to another logical Session. Recover the original target Session instead."
      );
    }
    const targetAgent = this.getAgentForSession(recipientSessionId);
    if (targetAgent?.agentId !== task.recipientAgentId) {
      throw domainError("RECIPIENT_SESSION_AGENT_MISMATCH", "The replacement Session is not bound to the collaboration recipient Agent.");
    }
    const route = this.#routeForSession(recipientSessionId);
    if (route?.workId !== task.targetWorkId) {
      throw domainError("TARGET_WORK_MISMATCH", "The replacement Session does not belong to the collaboration target Work.");
    }
    const stableSessionId = this.#stableSessionIdentity(recipientSessionId);
    const timestamp = this.clock();
    this.#transaction(() => {
      this.store.db.run(
        `UPDATE collaboration_requests SET recipient_session_id=?, routing_version=?, recipient_binding_id=?,
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

  listInbox(sessionId, options = {}) {
    return this.#listTasks("recipient_session_id", this.#stableSessionIdentity(requiredId(sessionId, "sessionId")), options);
  }

  listOutbox(sessionId, options = {}) {
    return this.#listTasks("initiator_session_id", this.#stableSessionIdentity(requiredId(sessionId, "sessionId")), options);
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
      `SELECT * FROM collaboration_requests ${where} ORDER BY updated_at DESC LIMIT ?`,
      params
    ).map((row) => taskFromRow(row, this.store));
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
    const initiatorSessionMatches = this.#sessionIdentityMatches(options.actorSessionId, task.initiatorSessionId);
    const recipientSessionMatches = this.#sessionIdentityMatches(options.actorSessionId, task.recipientSessionId);
    const isInitiator = actorAgentId === task.initiatorAgentId && initiatorSessionMatches;
    const isRecipient = actorAgentId === task.recipientAgentId && recipientSessionMatches;
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
        timestamp,
        options.actorSessionId
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
      const artifactId = this.#insertArtifact(task, actorAgentId, input.actorSessionId, artifact, timestamp);
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
      this.#appendEvent(taskId, "result_delivered", actorAgentId, { messageId: message.messageId, artifactId }, timestamp, input.actorSessionId);
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

  retryDeliveryAfterInfrastructureRepair(deliveryId, reason) {
    const recoveryReason = requiredText(reason, "reason");
    let recovered = false;
    this.#transaction(() => {
      const delivery = this.getDelivery(deliveryId);
      if (!delivery) throw domainError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} was not found.`);
      if (delivery.status !== "failed") return;
      const envelope = this.getDeliveryEnvelope(deliveryId);
      const timestamp = this.clock();
      this.store.db.run(
        `UPDATE collaboration_deliveries SET status = 'pending', attempt_count = 0,
         next_attempt_at = NULL, delivered_at = NULL, target_turn_id = NULL,
         last_error = NULL, updated_at = ? WHERE delivery_id = ? AND status = 'failed'`,
        [timestamp, deliveryId]
      );
      this.#appendEvent(envelope.task.taskId, "delivery_recovered", null, {
        deliveryId,
        reason: recoveryReason,
        previousAttemptCount: delivery.attemptCount,
        previousError: delivery.lastError
      }, timestamp);
      recovered = true;
    });
    return recovered ? this.getDelivery(deliveryId) : null;
  }

  getDeliveryEnvelope(deliveryId) { return this.deliveryReader.getDeliveryEnvelope(deliveryId); }
  listPendingDeliveries(limit = 100, maxAttempts = Number.MAX_SAFE_INTEGER) {
    return this.deliveryReader.listPendingDeliveries(limit, maxAttempts);
  }
  listQueuedDeliveriesForAgent(agentId, limit = 100) {
    return this.deliveryReader.listQueuedDeliveriesForAgent(agentId, limit);
  }
  listQueuedDeliveries(limit = 100) { return this.deliveryReader.listQueuedDeliveries(limit); }

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

  reconcileCompletedAgentWork(task) {
    if (task?.kind !== "collaboration" || task?.status !== "completed" || !task.deliveryId) {
      return null;
    }
    const delivery = this.getDelivery(task.deliveryId);
    if (!delivery) {
      throw domainError("DELIVERY_NOT_FOUND", `Delivery ${task.deliveryId} was not found.`);
    }
    if (delivery.status === "delivered") return delivery;
    if (delivery.recipientAgentId !== task.agentId) {
      throw domainError(
        "DELIVERY_RECIPIENT_MISMATCH",
        `Completed work ${task.taskId} does not belong to delivery recipient ${delivery.recipientAgentId}.`
      );
    }
    const logical = this.store.getLogicalSessionByLegacySessionId(task.sessionId)
      ?? this.store.getLogicalSession(task.sessionId);
    if (!logical?.logicalSessionId || !task.targetTurnId) {
      throw domainError(
        "DELIVERY_COMPLETION_PROOF_INCOMPLETE",
        `Completed work ${task.taskId} has no durable Session and turn proof.`
      );
    }
    const reconciled = this.updateDelivery(delivery.deliveryId, {
      status: "delivered",
      deliveredAt: this.clock(),
      targetTurnId: task.targetTurnId,
      targetSessionId: logical.logicalSessionId,
      nextAttemptAt: null,
      lastError: null
    });
    this.recordDeliveryEvent(delivery.deliveryId, "delivery_reconciled", {
      sessionId: logical.logicalSessionId,
      targetTurnId: task.targetTurnId,
      reason: "provider_turn_completed_after_dispatch_interruption"
    });
    return reconciled;
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
        this.#closeChannelIfSettled(deliveryId, timestamp);
        if (this.getChannel(this.getDeliveryEnvelope(deliveryId)?.task?.taskId)?.status !== "closed") {
          this.#establishChannel(deliveryId, patch.targetSessionId, timestamp);
        }
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

  #establishChannel(deliveryId, targetSessionId, timestamp) {
    return this.taskChannels.establishChannel(deliveryId, targetSessionId, timestamp);
  }

  #invalidateChannelsForSession(sessionId, reason, timestamp) {
    return this.taskChannels.invalidateChannelsForSession(sessionId, reason, timestamp);
  }

  #closeChannelIfSettled(deliveryId, timestamp) {
    return this.taskChannels.closeChannelIfSettled(deliveryId, timestamp);
  }

  #listTasks(column, sessionId, options) {
    const conditions = [`${column} = ?`];
    const params = [sessionId];
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      if (statuses.length) {
        conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    params.push(Math.max(1, Math.min(500, Number(options.limit) || 100)));
    return this.store.selectAll(
      `SELECT * FROM collaboration_requests WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ?`,
      params
    ).map((row) => taskFromRow(row, this.store));
  }

  #messageTransition(task, input) {
    const timestamp = this.clock();
    const sendsForward = this.#sessionIdentityMatches(input.options.actorSessionId, task.initiatorSessionId);
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
      }, timestamp, input.options.actorSessionId);
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
      this.#appendEvent(taskId, eventType, actorAgentId, { from: task.status, to: toStatus, ...payload }, timestamp, actorSessionId);
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
      `UPDATE collaboration_requests SET routing_version=?, recipient_binding_id=?, route_status='recovered', updated_at=?
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

  #insertMessage(input) { return this.recordWriter.insertMessage(input); }
  #insertArtifact(task, producerAgentId, producerSessionId, input, timestamp) {
    return this.recordWriter.insertArtifact(task, producerAgentId, producerSessionId, input, timestamp);
  }
  #appendEvent(taskId, type, actorAgentId, payload, timestamp, actorSessionId = null) {
    return this.recordWriter.appendEvent(taskId, type, actorAgentId, payload, timestamp, actorSessionId);
  }

  #updateTaskStatus(taskId, status, timestamp, iteration) {
    const completedAt = TERMINAL_TASK_STATUSES.has(status) ? timestamp : null;
    if (iteration == null) {
      this.store.db.run(
        "UPDATE collaboration_requests SET status = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
        [status, timestamp, completedAt, taskId]
      );
    } else {
      this.store.db.run(
        "UPDATE collaboration_requests SET status = ?, iteration = ?, updated_at = ?, completed_at = ? WHERE task_id = ?",
        [status, iteration, timestamp, completedAt, taskId]
      );
    }
    const artifactStatus = ["delivered", "verifying", "completed"].includes(status) ? "delivered"
      : ["rejected", "canceled", "escalated"].includes(status) ? "canceled" : "pending";
    const acceptanceStatus = status === "completed" ? "accepted"
      : status === "revision_requested" ? "revision_requested"
        : ["rejected", "canceled", "escalated"].includes(status) ? "rejected" : "pending";
    this.store.db.run(
      "UPDATE collaboration_requests SET artifact_status = ?, acceptance_status = ? WHERE task_id = ?",
      [artifactStatus, acceptanceStatus, taskId]
    );
    const task = this.store.selectOne(
      "SELECT target_task_id FROM collaboration_requests WHERE task_id = ?",
      [taskId]
    );
    if (task?.target_task_id) this.#syncTaskStatus(task.target_task_id, taskId, status, timestamp);
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

  #resolveTaskScope(...args) { return this.taskScope.resolveTaskScope(...args); }
  #assertSessionParticipants(...args) { return this.taskScope.assertSessionParticipants(...args); }
  #initialRecipientSessionId(...args) { return this.taskScope.initialRecipientSessionId(...args); }
  #routeForSession(...args) { return this.taskScope.routeForSession(...args); }
  #isAssignableContributor(...args) { return this.taskScope.isAssignableContributor(...args); }
  #ensureCompatibilityWork(...args) { return this.taskScope.ensureCompatibilityWork(...args); }
  #ensureWorkContributor(...args) { return this.taskScope.ensureWorkContributor(...args); }
  #validateRequestedTask(...args) { return this.taskScope.validateRequestedTask(...args); }
  #ensureCollaborationTask(...args) { return this.taskScope.ensureCollaborationTask(...args); }

  #syncTaskStatus(productTaskId, collaborationTaskId, taskStatus, timestamp) {
    const executionStatus = taskStatus === "working" || taskStatus === "revision_requested"
      ? "running"
      : taskStatus === "completed"
        ? "completed"
        : ["rejected", "canceled", "escalated"].includes(taskStatus)
          ? "failed"
          : taskStatus === "delivered" || taskStatus === "verifying"
            ? "awaiting_acceptance"
            : "idle";
    // A collaboration Task settling is execution evidence, not direct user
    // intent to complete its resource Task. Preserve the lifecycle status;
    // only the dedicated acceptance and completion workflows may change it.
    this.store.updateTask(productTaskId, { executionStatus });
  }


  #workForSession(sessionId) {
    if (!sessionId) return null;
    const logical = this.store.getLogicalSession(sessionId);
    const session = this.store.getSession(sessionId)
      ?? (logical?.legacySessionId ? this.store.getSession(logical.legacySessionId) : null);
    const workId = session?.workId ?? session?.work_id ?? null;
    return workId && this.store.getWork(workId) ? workId : null;
  }

  #assertActor(task, actorAgentId, role, actorSessionId = null) {
    const expected = role === "initiator" ? task.initiatorAgentId : task.recipientAgentId;
    if (actorAgentId !== expected) {
      throw domainError("ACTOR_NOT_AUTHORIZED", `Only the task ${role} (${expected}) may perform this action.`);
    }
    const expectedSessionId = role === "initiator" ? task.initiatorSessionId : task.recipientSessionId;
    if (!this.#sessionIdentityMatches(actorSessionId, expectedSessionId)) {
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
    return this.store.runInTransaction(() => {
      const result = run();
      this.store.scheduleSave();
      return result;
    });
  }
}
