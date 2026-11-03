import { randomUUID } from "node:crypto";

const CHANNEL_STATUSES = new Set(["pending_authorization", "active", "revoked", "legacy_unresolved"]);
const MESSAGE_KINDS = new Set(["message", "question", "update"]);

export class SessionChannelService {
  constructor({ store, collaborationCore, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
    if (!store || !collaborationCore) {
      throw new TypeError("SessionChannelService requires store and collaborationCore.");
    }
    this.store = store;
    this.collaborationCore = collaborationCore;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  requestChannel(input = {}) {
    const source = this.#requireActiveLogicalSession(input.requestingSessionId, "requestingSessionId");
    const recipient = input.recipientSessionId
      ? this.#requireActiveLogicalSession(input.recipientSessionId, "recipientSessionId")
      : null;
    if (recipient && recipient.logicalSessionId === source.logicalSessionId) {
      throw channelError("CHANNEL_SELF_TARGET_FORBIDDEN", "A Session cannot open a Channel to itself.");
    }
    const body = requiredText(input.body, "body");
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    const existingRequest = this.store.selectOne(
      "SELECT * FROM session_collaboration_channel_requests WHERE requesting_session_id=? AND idempotency_key=?",
      [source.logicalSessionId, idempotencyKey]
    );
    if (existingRequest) {
      const presented = this.#presentRequest(existingRequest);
      if (!sameChannelRequest(presented, input, recipient?.logicalSessionId ?? null)) {
        throw channelError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "This Channel idempotency key was already used with different request parameters.",
          409
        );
      }
      const resolved = this.tryConfirmPendingPolicyRequest(presented, input);
      if (resolved) return resolved;
      const authorization = presented.status === "confirmed" && this.store.selectOne(
        "SELECT json_extract(evidence_json,'$.type') AS policy FROM session_collaboration_channel_authorizations WHERE request_id=? AND json_extract(evidence_json,'$.type') IN ('parent_child_policy','first_message_confirmation_disabled')", [presented.requestId]);
      if (authorization) {
        return this.authorizedSendReceipt(presented, input, authorization.policy);
      }
      return presented;
    }

    if (recipient) {
      const active = this.findActiveChannel(source.logicalSessionId, recipient.logicalSessionId);
      if (active) {
        const sent = this.sendMessage({
          channelId: active.channelId,
          senderSessionId: source.logicalSessionId,
          body,
          messageKind: input.messageKind,
          deliveryIntent: input.deliveryIntent,
          inReplyToMessageId: input.inReplyToMessageId,
          idempotencyKey
        });
        return { status: "sent", routeAuthorization: "active_channel", channel: active, ...sent };
      }
    }
    if (optionalText(input.inReplyToMessageId)) {
      throw channelError(
        "CHANNEL_REPLY_REQUIRES_ACTIVE_CHANNEL",
        "A reply can only reference a message in an already active Channel.",
        409
      );
    }

    const requestId = optionalText(input.requestId) ?? `channel_request:${this.idFactory()}`;
    const timestamp = this.clock();
    const request = {
      body,
      messageKind: normalizeMessageKind(input.messageKind),
      deliveryIntent: normalizeDeliveryIntent(input.deliveryIntent),
      inReplyToMessageId: optionalText(input.inReplyToMessageId),
      targetWorkId: optionalText(input.targetWorkId),
      sessionAgentId: optionalText(input.sessionAgentId),
      taskId: optionalText(input.taskId),
      title: optionalText(input.title),
      summary: optionalText(input.summary) ?? body,
      sourceContext: this.#resourceContext(source.logicalSessionId)
    };
    const authorization = recipient ? this.resolveAutomaticAuthorization(source.logicalSessionId, recipient.logicalSessionId) : null;
    let confirmed;
    this.store.runInTransaction(() => {
    this.store.db.run(
      `INSERT INTO session_collaboration_channel_requests (
         request_id, channel_id, requesting_session_id, requested_recipient_session_id,
         request_json, status, idempotency_key, first_message_id, failure_json, created_at, resolved_at
       ) VALUES (?, NULL, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL)`,
      [requestId, source.logicalSessionId, recipient?.logicalSessionId ?? null,
        JSON.stringify(request), idempotencyKey, timestamp]
    );
    if (authorization) {
      confirmed = this.confirmRequest(requestId, {}, authorization);
    }
    });
    this.store.scheduleSave();
    if (confirmed) return this.authorizedSendReceipt(confirmed, input, authorization.type);
    return this.getRequest(requestId);
  }

  resolveParentChildAuthorization(sourceId, recipientId) {
    const sourceLogical = this.#requireActiveLogicalSession(sourceId, "sourceSessionId");
    const recipientLogical = this.#requireActiveLogicalSession(recipientId, "recipientSessionId");
    const source = this.#resourceContext(sourceLogical.logicalSessionId), recipient = this.#resourceContext(recipientLogical.logicalSessionId);
    if (!source.taskId || !recipient.taskId || !source.workId || source.workId !== recipient.workId) return null;
    const sourceTask = this.store.getTask(source.taskId), recipientTask = this.store.getTask(recipient.taskId);
    if (!sourceTask || !recipientTask) return null;
    const parent = recipientTask.parent_task_id === sourceTask.id ? sourceTask : recipientTask;
    const child = recipientTask.parent_task_id === sourceTask.id ? recipientTask : sourceTask;
    if (!parent || !child || parent.parent_task_id || child.parent_task_id !== parent.id
      || parent.work_id !== child.work_id || parent.work_id !== source.workId
      || parent.archived || child.archived || parent.deletion_status || child.deletion_status
      || sourceTask.current_session_id !== sourceLogical.legacySessionId
      || recipientTask.current_session_id !== recipientLogical.legacySessionId) return null;
    const [a,b] = canonicalPair(sourceLogical.logicalSessionId,recipientLogical.logicalSessionId);
    if (this.store.selectOne("SELECT 1 FROM session_collaboration_channels WHERE session_a_id=? AND session_b_id=? AND status='revoked'",[a,b])) return null;
    return {type:"parent_child_policy",parentTaskId:parent.id,childTaskId:child.id,
      sourceSessionId:sourceLogical.logicalSessionId,recipientSessionId:recipientLogical.logicalSessionId};
  }

  resolveAutomaticAuthorization(sourceId, recipientId) {
    const parentChild = this.resolveParentChildAuthorization(sourceId, recipientId);
    if (parentChild) return parentChild;
    if (this.store.collaborationSettings().requireFirstMessageConfirmation) return null;
    const [a, b] = canonicalPair(sourceId, recipientId);
    // Disabling first-contact prompts never reverses an explicit revocation.
    if (this.store.selectOne("SELECT 1 FROM session_collaboration_channels WHERE session_a_id=? AND session_b_id=? AND status='revoked'", [a, b])) return null;
    return { type: "first_message_confirmation_disabled", sourceSessionId: sourceId, recipientSessionId: recipientId };
  }

  tryConfirmPendingPolicyRequest(request, input) {
    // Retry-driven repair only. Never replay historical/rejected requests or
    // resolve a missing recipient by choosing another Task's current Session.
    if (request.status !== "pending" || !request.requestedRecipientSessionId) return null;
    const evidence = this.resolveAutomaticAuthorization(request.requestingSessionId, request.requestedRecipientSessionId);
    if (!evidence) return null;
    const confirmed = this.confirmRequest(request.requestId, {}, evidence);
    return confirmed.status === "confirmed" ? this.authorizedSendReceipt(confirmed, input, evidence.type) : confirmed;
  }

  authorizedSendReceipt(request, input, policy) {
    const sent = this.sendMessage({channelId:request.channelId,senderSessionId:request.requestingSessionId,
      body:input.body,messageKind:input.messageKind,deliveryIntent:input.deliveryIntent,
      inReplyToMessageId:input.inReplyToMessageId,idempotencyKey:input.idempotencyKey});
    return {status:"sent",routeAuthorization:policy,requestId:request.requestId,...sent};
  }

  getRequest(requestId) {
    const row = this.store.selectOne(
      "SELECT * FROM session_collaboration_channel_requests WHERE request_id=?",
      [requiredText(requestId, "requestId")]
    );
    return row ? this.#presentRequest(row) : null;
  }

  pendingRequestForSession(sessionId) {
    const logical = this.#requireLogicalSession(sessionId, "sessionId");
    const row = this.store.selectOne(
      `SELECT * FROM session_collaboration_channel_requests
       WHERE requesting_session_id=? AND status='pending'
       ORDER BY created_at DESC LIMIT 1`,
      [logical.logicalSessionId]
    );
    return row ? this.#presentRequest(row) : null;
  }

  confirmRequest(requestId, target = {}, evidence = {}) {
    // Read and decide under the same Store transaction as all existing writes.
    // Concurrent user/policy confirmation must not create a second first message.
    this.store.runInTransaction(() => {
      const request = this.getRequest(requestId);
      if (!request) throw channelError("CHANNEL_REQUEST_NOT_FOUND", `Channel request ${requestId} was not found.`, 404);
      if (request.status !== "pending") return;
      const source = this.#requireActiveLogicalSession(request.requestingSessionId, "requestingSessionId");
      const recipientId = target.recipientSessionId ?? request.requestedRecipientSessionId;
      const recipient = this.#requireActiveLogicalSession(recipientId, "recipientSessionId");
      if (evidence?.type === "parent_child_policy") {
        const current = this.resolveParentChildAuthorization(source.logicalSessionId, recipient.logicalSessionId);
        if (!current || ["parentTaskId", "childTaskId", "sourceSessionId", "recipientSessionId"].some(key => current[key] !== evidence[key])) {
          throw channelError("CHANNEL_PARENT_CHILD_BINDING_CHANGED", "The current direct parent/child binding no longer authorizes this Channel.", 409);
        }
        evidence = current;
      }
      if (evidence?.type === "first_message_confirmation_disabled") {
        const current = this.resolveAutomaticAuthorization(source.logicalSessionId, recipient.logicalSessionId);
        if (current?.type !== evidence.type || evidence.sourceSessionId !== source.logicalSessionId
          || evidence.recipientSessionId !== recipient.logicalSessionId) {
          throw channelError("CHANNEL_CONFIRMATION_POLICY_CHANGED", "First-message confirmation is required for this Session pair.", 409);
        }
        evidence = current;
      }
      if (source.logicalSessionId === recipient.logicalSessionId) {
        throw channelError("CHANNEL_SELF_TARGET_FORBIDDEN", "A Session cannot open a Channel to itself.");
      }
      const [sessionAId, sessionBId] = canonicalPair(source.logicalSessionId, recipient.logicalSessionId);
      const timestamp = this.clock();
      let channel = this.findActiveChannel(sessionAId, sessionBId);
      if (!channel) {
        const channelId = `channel:${this.idFactory()}`;
        this.store.db.run(
          `INSERT INTO session_collaboration_channels (
             channel_id, session_a_id, session_b_id, status, requested_by_session_id,
             authorized_at, revoked_at, revocation_reason, resource_version, created_at, updated_at
           ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, 1, ?, ?)`,
          [channelId, sessionAId, sessionBId, source.logicalSessionId, timestamp, timestamp, timestamp]
        );
        channel = this.getChannel(channelId);
      }
      this.store.db.run(
        `INSERT INTO session_collaboration_channel_authorizations (
           authorization_id, request_id, channel_id, requesting_session_id, decision, evidence_json, decided_at
         ) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`,
        [`channel_authorization:${this.idFactory()}`, request.requestId, channel.channelId, source.logicalSessionId,
          JSON.stringify(evidence ?? {}), timestamp]
      );
      const message = this.#insertMessage(channel, {
        senderSessionId: source.logicalSessionId,
        body: request.request.body,
        messageKind: request.request.messageKind,
        deliveryIntent: request.request.deliveryIntent,
        inReplyToMessageId: request.request.inReplyToMessageId,
        idempotencyKey: request.idempotencyKey,
        resourceContext: {
          sender: this.#resourceContext(source.logicalSessionId),
          recipient: this.#resourceContext(recipient.logicalSessionId)
        }
      }, timestamp);
      this.store.db.run(
        `UPDATE session_collaboration_channel_requests
         SET channel_id=?, requested_recipient_session_id=?, status='confirmed',
             first_message_id=?, resolved_at=?, failure_json=NULL WHERE request_id=? AND status='pending'`,
        [channel.channelId, recipient.logicalSessionId, message.messageId, timestamp, request.requestId]
      );
    });
    this.store.scheduleSave();
    return this.getRequest(requestId);
  }

  rejectRequest(requestId, evidence = {}) {
    this.store.runInTransaction(() => {
      const request = this.getRequest(requestId);
      if (!request) throw channelError("CHANNEL_REQUEST_NOT_FOUND", `Channel request ${requestId} was not found.`, 404);
      if (request.status !== "pending") return;
      const timestamp = this.clock();
      this.store.db.run(
        `UPDATE session_collaboration_channel_requests
         SET status='rejected', failure_json=?, resolved_at=? WHERE request_id=? AND status='pending'`,
        [JSON.stringify(evidence ?? {}), timestamp, requestId]
      );
      this.store.db.run(
        `INSERT INTO session_collaboration_channel_authorizations (
           authorization_id, request_id, channel_id, requesting_session_id, decision, evidence_json, decided_at
         ) VALUES (?, ?, NULL, ?, 'rejected', ?, ?)`,
        [`channel_authorization:${this.idFactory()}`, request.requestId, request.requestingSessionId,
          JSON.stringify(evidence ?? {}), timestamp]
      );
    });
    this.store.scheduleSave();
    return this.getRequest(requestId);
  }

  failRequest(requestId, error) {
    const request = this.getRequest(requestId);
    if (!request || request.status !== "pending") return request;
    this.store.db.run(
      `UPDATE session_collaboration_channel_requests
       SET status='failed', failure_json=?, resolved_at=? WHERE request_id=? AND status='pending'`,
      [JSON.stringify({ code: error?.code ?? "CHANNEL_TARGET_PREPARATION_FAILED", message: error?.message ?? String(error) }),
        this.clock(), requestId]
    );
    this.store.scheduleSave();
    return this.getRequest(requestId);
  }

  findActiveChannel(firstSessionId, secondSessionId) {
    const [sessionAId, sessionBId] = canonicalPair(firstSessionId, secondSessionId);
    const row = this.store.selectOne(
      `SELECT * FROM session_collaboration_channels
       WHERE session_a_id=? AND session_b_id=? AND status='active'`,
      [sessionAId, sessionBId]
    );
    return row ? this.#presentChannel(row) : null;
  }

  hasChannelHistory(firstSessionId, secondSessionId) {
    const [sessionAId, sessionBId] = canonicalPair(firstSessionId, secondSessionId);
    return Boolean(this.store.selectOne(
      "SELECT channel_id FROM session_collaboration_channels WHERE session_a_id=? AND session_b_id=? LIMIT 1",
      [sessionAId, sessionBId]
    ));
  }

  getChannel(channelId) {
    const row = this.store.selectOne(
      "SELECT * FROM session_collaboration_channels WHERE channel_id=?",
      [requiredText(channelId, "channelId")]
    );
    return row ? this.#presentChannel(row) : null;
  }

  listChannels(sessionId, options = {}) {
    const logical = this.#requireLogicalSession(sessionId, "sessionId");
    const statuses = Array.isArray(options.statuses) && options.statuses.length
      ? options.statuses.map((status) => {
        if (!CHANNEL_STATUSES.has(status)) throw channelError("INVALID_CHANNEL_STATUS", `Unsupported Channel status: ${status}.`);
        return status;
      })
      : ["active"];
    const placeholders = statuses.map(() => "?").join(",");
    return this.store.selectAll(
      `SELECT * FROM session_collaboration_channels
       WHERE (session_a_id=? OR session_b_id=?) AND status IN (${placeholders})
       ORDER BY updated_at DESC LIMIT ?`,
      [logical.logicalSessionId, logical.logicalSessionId, ...statuses, boundedLimit(options.limit)]
    ).map((row) => this.#presentChannel(row));
  }

  sendMessage(input = {}) {
    const channel = this.getChannel(input.channelId);
    if (!channel) throw channelError("CHANNEL_NOT_FOUND", `Channel ${input.channelId} was not found.`, 404);
    if (channel.status !== "active") throw channelError("CHANNEL_NOT_ACTIVE", `Channel ${channel.channelId} is ${channel.status}.`, 409);
    const sender = this.#requireActiveLogicalSession(input.senderSessionId, "senderSessionId");
    if (![channel.sessionAId, channel.sessionBId].includes(sender.logicalSessionId)) {
      throw channelError("CHANNEL_PARTICIPANT_REQUIRED", "Only a Channel participant may send a message.", 403);
    }
    const existing = this.store.selectOne(
      "SELECT * FROM session_collaboration_messages WHERE sender_session_id=? AND idempotency_key=?",
      [sender.logicalSessionId, requiredText(input.idempotencyKey, "idempotencyKey")]
    );
    if (existing) {
      const requestedKind = normalizeMessageKind(input.messageKind);
      if (existing.channel_id !== channel.channelId
        || existing.body !== requiredText(input.body, "body")
        || existing.message_kind !== requestedKind
        || existing.delivery_intent !== normalizeDeliveryIntent(input.deliveryIntent)
        || (existing.in_reply_to_message_id ?? null) !== optionalText(input.inReplyToMessageId)) {
        throw channelError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "This Channel message idempotency key was already used with different parameters.",
          409
        );
      }
      return {
        channel,
        message: this.#presentMessage(existing),
        delivery: this.getDeliveryByMessage(existing.message_id),
        idempotentReplay: true
      };
    }
    const timestamp = this.clock();
    let message;
    this.store.runInTransaction(() => {
      message = this.#insertMessage(channel, {
        senderSessionId: sender.logicalSessionId,
        body: input.body,
        messageKind: input.messageKind,
        deliveryIntent: input.deliveryIntent,
        inReplyToMessageId: input.inReplyToMessageId,
        idempotencyKey: input.idempotencyKey,
        resourceContext: input.resourceContext ?? {
          sender: this.#resourceContext(sender.logicalSessionId),
          recipient: this.#resourceContext(peerSessionId(channel, sender.logicalSessionId))
        }
      }, timestamp);
    });
    this.store.scheduleSave();
    return {
      channel: this.getChannel(channel.channelId),
      message,
      delivery: this.getDeliveryByMessage(message.messageId),
      idempotentReplay: false
    };
  }

  listMessages(channelId, actorSessionId, options = {}) {
    return this.listMessagePage(channelId, actorSessionId, options).messages;
  }

  listMessagePage(channelId, actorSessionId, options = {}) {
    const channel = this.#requireParticipantChannel(channelId, actorSessionId);
    if (options.beforeCursor && options.afterCursor) throw channelError("INVALID_CHANNEL_CURSOR", "Use one cursor direction.");
    const cursor = options.beforeCursor ?? options.afterCursor;
    if (cursor != null && !/^[1-9][0-9]*$/.test(String(cursor))) throw channelError("INVALID_CHANNEL_CURSOR", "Invalid message cursor.");
    const ascending = Boolean(options.afterCursor);
    const limit = boundedLimit(options.limit, 100);
    const rows = this.store.selectAll(
      `SELECT m.*, o.sequence FROM session_collaboration_messages m
       JOIN session_collaboration_message_order o ON o.message_id=m.message_id
       WHERE m.channel_id=? ${cursor ? `AND o.sequence ${ascending ? ">" : "<"} ?` : ""}
       ORDER BY o.sequence ${ascending ? "ASC" : "DESC"} LIMIT ?`,
      [channel.channelId, ...(cursor ? [Number(cursor)] : []), limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!ascending) page.reverse();
    const deliveries = page.length ? this.store.selectAll(
      `SELECT d.*, i.batch_id, b.status AS batch_status, op.status AS execution_status,
        (SELECT COUNT(*) FROM session_collaboration_batch_items bi WHERE bi.batch_id=i.batch_id) AS message_count
       FROM session_collaboration_deliveries d
       LEFT JOIN session_collaboration_batch_items i ON i.delivery_id=d.delivery_id
       LEFT JOIN session_collaboration_batches b ON b.batch_id=i.batch_id
       LEFT JOIN agent_operations op ON op.task_id=b.operation_id
       WHERE d.message_id IN (${page.map(() => "?").join(",")})`, page.map(row => row.message_id)
    ) : [];
    const receipts = new Map(deliveries.map(row => [row.message_id, presentDelivery(row)]));
    const pendingCount = Number(this.store.selectOne(
      `SELECT COUNT(*) AS count FROM session_collaboration_deliveries d
       JOIN session_collaboration_messages m ON m.message_id=d.message_id
       WHERE m.channel_id=? AND d.status IN ('pending','queued')
       AND m.delivery_intent NOT IN ('notification','acknowledgement')`, [channel.channelId]
    )?.count ?? 0);
    return {
      pendingCount,
      messages: page.map(row => ({ ...this.#presentMessage(row), cursor: String(row.sequence),
        delivery: receipts.get(row.message_id) ?? null })),
      hasMore,
      beforeCursor: page.length ? String(page[0].sequence) : null,
      afterCursor: page.length ? String(page.at(-1).sequence) : null
    };
  }

  revokeChannel(channelId, actorSessionId, reason, evidence = {}) {
    const channel = this.#requireParticipantChannel(channelId, actorSessionId);
    if (channel.status === "revoked") return channel;
    if (channel.status !== "active") throw channelError("CHANNEL_NOT_ACTIVE", `Channel ${channel.channelId} is ${channel.status}.`, 409);
    const timestamp = this.clock();
    this.store.runInTransaction(() => {
      this.store.db.run(
        `UPDATE session_collaboration_channels SET status='revoked', revoked_at=?,
         revocation_reason=?, resource_version=resource_version+1, updated_at=? WHERE channel_id=?`,
        [timestamp, requiredText(reason, "reason"), timestamp, channel.channelId]
      );
      this.store.db.run(
        `INSERT INTO session_collaboration_channel_authorizations (
           authorization_id, request_id, channel_id, requesting_session_id, decision, evidence_json, decided_at
         ) VALUES (?, ?, ?, ?, 'revoked', ?, ?)`,
        [`channel_authorization:${this.idFactory()}`,
          this.store.selectOne(
            "SELECT request_id FROM session_collaboration_channel_requests WHERE channel_id=? ORDER BY resolved_at ASC LIMIT 1",
            [channel.channelId]
          )?.request_id,
          channel.channelId,
          this.#requireLogicalSession(actorSessionId, "actorSessionId").logicalSessionId,
          JSON.stringify(evidence ?? {}), timestamp]
      );
    });
    this.store.scheduleSave();
    return this.getChannel(channel.channelId);
  }

  listPendingDeliveries(limit = 100, maxAttempts = Number.MAX_SAFE_INTEGER) {
    return this.store.selectAll(
      `SELECT * FROM session_collaboration_deliveries
       WHERE status IN ('pending', 'failed') AND attempt_count < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      [maxAttempts, this.clock(), boundedLimit(limit)]
    ).map(presentDelivery);
  }

  listQueuedDeliveries(limit = 100) {
    return this.store.selectAll(
      "SELECT * FROM session_collaboration_deliveries WHERE status='queued' ORDER BY created_at ASC LIMIT ?",
      [boundedLimit(limit)]
    ).map(presentDelivery);
  }

  getDelivery(deliveryId) {
    const row = this.store.selectOne(
      `SELECT d.*, i.batch_id, b.status AS batch_status, op.status AS execution_status,
        (SELECT COUNT(*) FROM session_collaboration_batch_items bi WHERE bi.batch_id=i.batch_id) AS message_count
       FROM session_collaboration_deliveries d
       LEFT JOIN session_collaboration_batch_items i ON i.delivery_id=d.delivery_id
       LEFT JOIN session_collaboration_batches b ON b.batch_id=i.batch_id
       LEFT JOIN agent_operations op ON op.task_id=b.operation_id WHERE d.delivery_id=?`,
      [deliveryId]
    );
    return row ? presentDelivery(row) : null;
  }

  getDeliveryByMessage(messageId) {
    const row = this.store.selectOne(
      "SELECT * FROM session_collaboration_deliveries WHERE message_id=?",
      [messageId]
    );
    return row ? this.getDelivery(row.delivery_id) : null;
  }

  updateDelivery(deliveryId, patch = {}) {
    const current = this.getDelivery(deliveryId);
    if (!current) return null;
    const status = patch.status ?? current.status;
    if (!["pending", "queued", "delivering", "delivered", "failed"].includes(status)) {
      throw channelError("INVALID_DELIVERY_STATUS", `Unsupported delivery status: ${status}.`);
    }
    this.store.db.run(
      `UPDATE session_collaboration_deliveries SET status=?, attempt_count=?, next_attempt_at=?,
       delivered_at=?, target_turn_id=?, last_error=?, updated_at=? WHERE delivery_id=?`,
      [status, current.attemptCount + (patch.incrementAttempt ? 1 : 0),
        patch.nextAttemptAt !== undefined ? patch.nextAttemptAt : current.nextAttemptAt,
        patch.deliveredAt !== undefined ? patch.deliveredAt : current.deliveredAt,
        patch.targetTurnId !== undefined ? patch.targetTurnId : current.targetTurnId,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        this.clock(), deliveryId]
    );
    this.store.scheduleSave();
    return this.getDelivery(deliveryId);
  }

  claimDelivery(deliveryId) {
    this.store.db.run(
      `UPDATE session_collaboration_deliveries SET status='delivering', updated_at=?
       WHERE delivery_id=? AND status IN ('pending', 'queued', 'failed')`,
      [this.clock(), deliveryId]
    );
    if (this.store.db.getRowsModified() === 0) return null;
    this.store.scheduleSave();
    return this.getDelivery(deliveryId);
  }

  getDeliveryEnvelope(deliveryId) {
    const row = this.store.selectOne(
      `SELECT d.*, m.channel_id, m.sender_session_id, m.recipient_session_id AS message_recipient_session_id,
              m.delivery_intent, m.message_kind, m.body, m.in_reply_to_message_id, m.resource_context_json,
              m.idempotency_key, m.created_at AS message_created_at,
              c.session_a_id, c.session_b_id, c.status AS channel_status,
              c.requested_by_session_id, c.authorized_at, c.resource_version
       FROM session_collaboration_deliveries d
       JOIN session_collaboration_messages m ON m.message_id=d.message_id
       JOIN session_collaboration_channels c ON c.channel_id=m.channel_id
       WHERE d.delivery_id=?`,
      [deliveryId]
    );
    if (!row) return null;
    const senderAgent = this.collaborationCore.getAgentForSession(row.sender_session_id);
    const recipientAgent = this.collaborationCore.getAgentForSession(row.message_recipient_session_id);
    return {
      delivery: presentDelivery(row),
      channel: this.#presentChannel(row),
      message: {
        messageId: row.message_id,
        channelId: row.channel_id,
        senderSessionId: row.sender_session_id,
        recipientSessionId: row.message_recipient_session_id,
        senderAgentId: senderAgent?.agentId ?? null,
        senderAgentName: senderAgent?.name ?? null,
        recipientAgentId: recipientAgent?.agentId ?? null,
        recipientAgentName: recipientAgent?.name ?? null,
        messageKind: row.message_kind,
        deliveryIntent: row.delivery_intent ?? "action_required",
        body: row.body,
        inReplyToMessageId: row.in_reply_to_message_id ?? null,
        resourceContext: parseJson(row.resource_context_json, {}),
        createdAt: row.message_created_at
      }
    };
  }

  resolveDeliveryRoute(deliveryId) {
    const envelope = this.getDeliveryEnvelope(deliveryId);
    if (!envelope) throw channelError("CHANNEL_DELIVERY_ENVELOPE_MISSING", "Channel delivery envelope is unavailable.", 404);
    if (envelope.channel.status !== "active") {
      throw channelError("CHANNEL_NOT_ACTIVE", `Channel ${envelope.channel.channelId} is ${envelope.channel.status}.`, 409);
    }
    const logical = this.#requireActiveLogicalSession(envelope.message.recipientSessionId, "recipientSessionId");
    return {
      sessionId: logical.logicalSessionId,
      providerSessionId: logical.legacySessionId,
      routingVersion: Number(logical.routingVersion ?? 0),
      bindingId: logical.activeBinding?.bindingId ?? null
    };
  }

  #insertMessage(channel, input, timestamp) {
    const senderSessionId = requiredText(input.senderSessionId, "senderSessionId");
    const recipientSessionId = peerSessionId(channel, senderSessionId);
    const inReplyToMessageId = optionalText(input.inReplyToMessageId);
    if (inReplyToMessageId) {
      const replyTarget = this.store.selectOne(
        "SELECT channel_id FROM session_collaboration_messages WHERE message_id=?",
        [inReplyToMessageId]
      );
      if (!replyTarget) {
        throw channelError("CHANNEL_REPLY_MESSAGE_NOT_FOUND", `Channel message ${inReplyToMessageId} was not found.`, 404);
      }
      if (replyTarget.channel_id !== channel.channelId) {
        throw channelError(
          "CHANNEL_REPLY_SCOPE_MISMATCH",
          "A Channel message may only reply to another message in the same Channel.",
          409
        );
      }
    }
    const messageId = `channel_message:${this.idFactory()}`;
    const deliveryId = `channel_delivery:${this.idFactory()}`;
    this.store.db.run(
      `INSERT INTO session_collaboration_messages (
         message_id, channel_id, sender_session_id, recipient_session_id, message_kind, delivery_intent,
         body, in_reply_to_message_id, resource_context_json, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, channel.channelId, senderSessionId, recipientSessionId,
        normalizeMessageKind(input.messageKind), normalizeDeliveryIntent(input.deliveryIntent), requiredText(input.body, "body"),
        inReplyToMessageId, JSON.stringify(input.resourceContext ?? {}),
        requiredText(input.idempotencyKey, "idempotencyKey"), timestamp]
    );
    this.store.db.run(
      `INSERT INTO session_collaboration_deliveries (
         delivery_id, message_id, recipient_session_id, status, attempt_count,
         next_attempt_at, delivered_at, target_turn_id, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      [deliveryId, messageId, recipientSessionId, timestamp, timestamp]
    );
    this.store.db.run(
      "UPDATE session_collaboration_channels SET updated_at=? WHERE channel_id=?",
      [timestamp, channel.channelId]
    );
    return this.#presentMessage(this.store.selectOne(
      "SELECT * FROM session_collaboration_messages WHERE message_id=?",
      [messageId]
    ));
  }

  #resourceContext(sessionId) {
    const logical = this.#requireLogicalSession(sessionId, "sessionId");
    const session = logical.legacySessionId ? this.store.getSession(logical.legacySessionId) : null;
    return {
      sessionId: logical.logicalSessionId,
      workId: session?.workId ?? null,
      taskId: session?.taskId ?? null,
      agentId: session?.agentId ?? this.collaborationCore.getAgentForSession(logical.logicalSessionId)?.agentId ?? null,
      repositoryId: logical.repositoryId ?? null,
      worktreeId: logical.activeWorkspaceId ?? null,
      routingVersion: Number(logical.routingVersion ?? 0)
    };
  }

  #requireParticipantChannel(channelId, actorSessionId) {
    const channel = this.getChannel(channelId);
    if (!channel) throw channelError("CHANNEL_NOT_FOUND", `Channel ${channelId} was not found.`, 404);
    const actor = this.#requireLogicalSession(actorSessionId, "actorSessionId");
    if (![channel.sessionAId, channel.sessionBId].includes(actor.logicalSessionId)) {
      throw channelError("CHANNEL_PARTICIPANT_REQUIRED", "The authenticated Session is not a Channel participant.", 403);
    }
    return channel;
  }

  #requireLogicalSession(sessionId, field) {
    const normalized = requiredText(sessionId, field);
    const logical = this.store.getLogicalSession(normalized)
      ?? this.store.getLogicalSessionByLegacySessionId(normalized);
    if (!logical) throw channelError("SESSION_NOT_FOUND", `Session ${normalized} was not found.`, 404);
    return logical;
  }

  #requireActiveLogicalSession(sessionId, field) {
    const logical = this.#requireLogicalSession(sessionId, field);
    const session = logical.legacySessionId ? this.store.getSession(logical.legacySessionId) : null;
    if (!session || session.deletedAt || session.archived || logical.archived || logical.activeBinding?.state !== "active") {
      throw channelError("SESSION_UNAVAILABLE", `Session ${logical.logicalSessionId} is not an active Channel endpoint.`, 409);
    }
    return logical;
  }

  #presentChannel(row) {
    return {
      channelId: row.channel_id,
      sessionAId: row.session_a_id,
      sessionBId: row.session_b_id,
      status: row.channel_status ?? row.status,
      requestedBySessionId: row.requested_by_session_id,
      authorizedAt: row.authorized_at ?? null,
      revokedAt: row.revoked_at ?? null,
      revocationReason: row.revocation_reason ?? null,
      resourceVersion: Number(row.resource_version ?? 1),
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null
    };
  }

  #presentMessage(row) {
    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      senderSessionId: row.sender_session_id,
      recipientSessionId: row.recipient_session_id,
      messageKind: row.message_kind,
      deliveryIntent: row.delivery_intent ?? "action_required",
      body: row.body,
      inReplyToMessageId: row.in_reply_to_message_id ?? null,
      resourceContext: parseJson(row.resource_context_json, {}),
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at
    };
  }

  #presentRequest(row) {
    return {
      requestId: row.request_id,
      channelId: row.channel_id ?? null,
      requestingSessionId: row.requesting_session_id,
      requestedRecipientSessionId: row.requested_recipient_session_id ?? null,
      request: parseJson(row.request_json, {}),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      firstMessageId: row.first_message_id ?? null,
      failure: parseJson(row.failure_json, null),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? null
    };
  }
}

function canonicalPair(first, second) {
  const left = requiredText(first, "firstSessionId");
  const right = requiredText(second, "secondSessionId");
  if (left === right) throw channelError("CHANNEL_SELF_TARGET_FORBIDDEN", "A Session cannot open a Channel to itself.");
  return left < right ? [left, right] : [right, left];
}

function peerSessionId(channel, senderSessionId) {
  if (senderSessionId === channel.sessionAId) return channel.sessionBId;
  if (senderSessionId === channel.sessionBId) return channel.sessionAId;
  throw channelError("CHANNEL_PARTICIPANT_REQUIRED", "The sender is not a Channel participant.", 403);
}

function normalizeMessageKind(value) {
  const kind = optionalText(value) ?? "message";
  if (!MESSAGE_KINDS.has(kind)) throw channelError("INVALID_MESSAGE_KIND", `Unsupported Channel message kind: ${kind}.`);
  return kind;
}

function sameChannelRequest(existing, input, recipientSessionId) {
  const stored = existing.request ?? {};
  return existing.requestedRecipientSessionId === recipientSessionId
    && stored.body === requiredText(input.body, "body")
    && stored.messageKind === normalizeMessageKind(input.messageKind)
    && (stored.deliveryIntent ?? "action_required") === normalizeDeliveryIntent(input.deliveryIntent)
    && (stored.inReplyToMessageId ?? null) === optionalText(input.inReplyToMessageId)
    && (stored.targetWorkId ?? null) === optionalText(input.targetWorkId)
    && (stored.sessionAgentId ?? null) === optionalText(input.sessionAgentId)
    && (stored.taskId ?? null) === optionalText(input.taskId)
    && (stored.title ?? null) === optionalText(input.title)
    && (stored.summary ?? stored.body) === (optionalText(input.summary) ?? requiredText(input.body, "body"));
}

function presentDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    recipientSessionId: row.recipient_session_id,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    targetTurnId: row.target_turn_id ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    batchId: row.batch_id ?? null,
    batchStatus: row.batch_status ?? null,
    executionStatus: row.execution_status ?? null,
    messageCount: Number(row.message_count ?? 0)
  };
}

function boundedLimit(value, fallback = 100) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw channelError("INVALID_CHANNEL_INPUT", `${field} is required.`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function channelError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeDeliveryIntent(value) {
  const intent = optionalText(value) ?? "action_required";
  if (!["action_required", "response_required", "notification", "acknowledgement"].includes(intent)) {
    throw channelError("INVALID_DELIVERY_INTENT", `Unsupported delivery intent: ${intent}.`);
  }
  return intent;
}
