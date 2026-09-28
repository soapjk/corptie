import { createCollaborationEnvelope } from "./collaborationProtocol.mjs";

export function agentFromRow(row, store, sessionReference = null) {
  const selectedSessionId = typeof sessionReference === "string"
    ? sessionReference
    : sessionReference?.logicalSessionId ?? sessionReference?.legacySessionId ?? row.current_session_id;
  const logical = selectedSessionId
    ? (store.getLogicalSession(selectedSessionId) ?? store.getLogicalSessionByLegacySessionId(selectedSessionId))
    : null;
  const selectedProviderSessionId = logical?.legacySessionId ?? selectedSessionId;
  const selectedSession = selectedProviderSessionId ? store.getSession(selectedProviderSessionId) : null;
  const currentSession = row.current_session_id ? store.getSession(row.current_session_id) : null;
  const workIds = store.listWorks()
    .filter((work) => (work.contributorAgentIds ?? []).includes(row.agent_id))
    .map((work) => work.id);
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
    currentWorkId: currentSession?.workId ?? null,
    currentTaskId: currentSession?.taskId ?? null,
    workIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function serviceFromRow(row) {
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

export function taskFromRow(row, store = null) {
  const sourceWork = store?.getWork(row.source_work_id);
  const targetWork = store?.getWork(row.target_work_id);
  const sourceTask = row.source_task_id ? store?.getTask(row.source_task_id) : null;
  const targetTask = row.target_task_id ? store?.getTask(row.target_task_id) : null;
  const initiatorSession = store ? sessionPresentationSnapshot(store, row.initiator_session_id) : null;
  const recipientSession = store ? sessionPresentationSnapshot(store, row.recipient_session_id) : null;
  return {
    taskId: row.task_id,
    contextId: row.context_id,
    parentTaskId: row.parent_task_id || null,
    protocolVersion: row.protocol_version,
    sourceWorkId: row.source_work_id,
    sourceWorkName: sourceWork?.name ?? null,
    targetWorkId: row.target_work_id,
    targetWorkName: targetWork?.name ?? null,
    sourceTaskId: row.source_task_id || null,
    sourceTaskTitle: sourceTask?.title ?? null,
    targetTaskId: row.target_task_id || null,
    taskTitle: targetTask?.title ?? null,
    initiatorAgentId: row.initiator_agent_id,
    recipientAgentId: row.recipient_agent_id,
    initiatorSessionId: row.initiator_session_id || null,
    recipientSessionId: row.recipient_session_id || null,
    // Compatibility field names; presentation always resolves the current
    // resource-derived Session name instead of retaining a stale snapshot.
    initiatorNameAtSend: initiatorSession?.title ?? row.initiator_name_at_send ?? null,
    recipientNameAtSend: recipientSession?.title ?? row.recipient_name_at_send ?? null,
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

export function messageFromRow(row) {
  const payload = parseJson(row.payload_json, {
    body: row.body,
    evidence: parseJson(row.evidence_json, []),
    resourceVersion: row.resource_version || null
  });
  const error = parseJson(row.error_json, null);
  const envelope = row.sender_session_id && row.recipient_session_id ? createCollaborationEnvelope({
    messageId: row.message_id,
    taskId: row.task_id,
    messageType: row.message_type,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    senderSessionId: row.sender_session_id,
    recipientSessionId: row.recipient_session_id,
    sourceWorkId: row.source_work_id,
    targetWorkId: row.target_work_id,
    sourceTaskId: row.source_task_id,
    targetTaskId: row.target_task_id,
    payload,
    timestamp: row.created_at,
    error
  }) : null;
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

export function artifactFromRow(row) {
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    producerAgentId: row.producer_agent_id,
    producerSessionId: row.producer_session_id || null,
    type: row.type,
    name: row.name,
    uri: row.uri,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

export function eventFromRow(row) {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    type: row.type,
    actorAgentId: row.actor_agent_id || null,
    actorSessionId: row.actor_session_id || null,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}

export function deliveryFromRow(row) {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    recipientAgentId: row.recipient_agent_id,
    recipientSessionId: row.recipient_session_id || row.message_recipient_session_id || null,
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

export function channelFromRow(row) {
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

export function taskConfirmationFromRow(row, core) {
  const request = parseJson(row.request_json, {});
  const presentation = request.presentation ?? {};
  const initiator = core.getAgent(row.initiator_agent_id);
  const recipient = core.getAgent(row.recipient_agent_id);
  const recipientRouteUnresolved = Boolean(request.routingIntent || request.sessionAgentId) && !row.recipient_session_id;
  const initiatorSessionId = row.initiator_session_id || initiator?.sessionId || null;
  const recipientSessionId = row.recipient_session_id || (recipientRouteUnresolved ? null : recipient?.sessionId) || null;
  const currentInitiator = sessionPresentationSnapshot(core.store, initiatorSessionId);
  const currentRecipient = sessionPresentationSnapshot(core.store, recipientSessionId);
  return {
    confirmationId: row.confirmation_id,
    initiatorAgentId: row.initiator_agent_id,
    initiatorSessionId,
    initiatorAgentName: presentation.initiatorAgentName || initiator?.name || row.initiator_agent_id,
    initiatorSessionTitle: currentInitiator?.title ?? presentation.initiatorSession?.title ?? null,
    initiatorSessionKind: presentation.initiatorSession?.sessionKind || null,
    initiatorTaskId: presentation.initiatorSession?.taskId || request.sourceTaskId || null,
    recipientAgentId: row.recipient_agent_id,
    recipientSessionId,
    recipientAgentName: presentation.recipientAgentName || recipient?.name || row.recipient_agent_id,
    recipientSessionTitle: currentRecipient?.title ?? presentation.recipientSession?.title ?? null,
    recipientSessionKind: presentation.recipientSession?.sessionKind || null,
    recipientTaskId: presentation.recipientSession?.taskId || request.targetTaskId || null,
    sourceWorkId: presentation.sourceWork?.id || request.sourceWorkId || null,
    sourceWorkName: presentation.sourceWork?.name || request.sourceWorkId || null,
    targetWorkId: presentation.targetWork?.id || request.targetWorkId || null,
    targetWorkName: presentation.targetWork?.name || request.targetWorkId || null,
    sourceSessionId: row.source_session_id || null,
    sourceTurnId: row.source_turn_id || null,
    request,
    status: row.status,
    taskId: row.task_id || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

export function sessionPresentationSnapshot(store, sessionId) {
  if (!sessionId) return null;
  const logical = store.getLogicalSession(sessionId) ?? store.getLogicalSessionByLegacySessionId(sessionId);
  const providerSessionId = logical?.legacySessionId ?? sessionId;
  const session = store.getSession(providerSessionId);
  if (!session) return null;
  return {
    id: logical?.logicalSessionId ?? session.logicalSessionId ?? session.id,
    title: logical?.sessionName ?? session.title,
    sessionKind: session.sessionKind,
    taskId: session.taskId ?? null
  };
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
