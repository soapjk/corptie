import { createHash, randomUUID } from "node:crypto";
import {
  API_V1_VERSION,
  apiV1ActionRequestSchema,
  apiV1ActionResponseSchema,
  apiV1AttentionResponseSchema,
  apiV1BootstrapResponseSchema,
  apiV1CreateSessionRequestSchema,
  apiV1EventSchema,
  apiV1SessionResponseSchema,
  apiV1SessionsResponseSchema,
  parseApiV1
} from "../http/apiV1Contract.mjs";

const VALID_STATUSES = new Set(["running", "blocked", "complete", "failed", "cancelled"]);
const VALID_ACCENTS = new Set(["cyan", "mint", "violet", "amber"]);
const FULL_CONTROL_ACTIONS = new Set([
  "session.interrupt",
  "session.reconnect",
  "session.archive",
  "session.unarchive",
  "session.pin",
  "session.rename",
  "session.delete",
  "session.model.set",
  "session.reasoning.set",
  "session.permissions.set",
  "turn.diff.open-on-mac",
  "turn.diff.undo"
]);
const REPLY_ACTIONS = new Set([
  "message.send",
  "choice.respond",
  "approval.respond",
  "collaboration.confirm",
  "collaboration.reject"
]);
const IMPLEMENTED_ACTIONS = new Set([
  "message.send",
  "session.interrupt",
  "session.reconnect",
  "session.model.set",
  "session.reasoning.set",
  "session.permissions.set",
  "session.archive",
  "session.unarchive",
  "session.pin",
  "session.rename",
  "session.delete",
  ...REPLY_ACTIONS
]);

export class ApiV1Service {
  constructor(options = {}) {
    this.store = options.store;
    this.environmentName = options.environmentName === "development" ? "development" : "production";
    this.listSessions = options.listSessions ?? (() => []);
    this.getSession = options.getSession ?? (() => null);
    this.perform = options.perform ?? (async () => {
      throw apiError("ACTION_NOT_AVAILABLE", "This action is not available.");
    });
    this.eventCursor = options.eventCursor ?? (() => 0);
    this.eventsAfter = options.eventsAfter ?? (() => []);
    this.subscribeEvents = options.subscribeEvents ?? (() => () => {});
    this.creationOptions = options.creationOptions ?? (async () => ({
      workspaces: [], agents: ["codex", "claude"], models: { codex: [], claude: [] }, defaults: {
        agent: "codex", workspace: null, codexModel: null, claudeModel: null,
        reasoningLevel: "medium", sandbox: "workspace-write", approvalPolicy: "on-request"
      }
    }));
    this.createSession = options.createSession ?? (async () => null);
    this.reorderSessions = options.reorderSessions ?? (() => []);
    this.getSessionMetadata = options.getSessionMetadata ?? (async () => ({}));
    this.getCollaborationOverview = options.getCollaborationOverview ?? (() => ({ agents: [], services: [], tasks: [] }));
    this.getCollaborationTask = options.getCollaborationTask ?? (() => null);
    this.performCollaborationAction = options.performCollaborationAction ?? (() => null);
    this.getTurnDiff = options.getTurnDiff ?? (async () => null);
    this.performTurnAction = options.performTurnAction ?? (async () => null);
    this.clock = options.clock ?? (() => new Date());
  }

  async turnDiff(sessionId, turnId) {
    const session = this.listSessions().find((entry) => entry.id === sessionId);
    if (!session) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    const result = await this.getTurnDiff(sessionId, turnId);
    if (!result) throw apiError("INVALID_REQUEST", "Turn diff not found.");
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      sessionId,
      turnId,
      files: result.files.map((path) => String(path)),
      diff: String(result.diff ?? "")
    };
  }

  async turnAction(sessionId, turnId, input, context) {
    if (context.webSession.device.permission !== "full-control") {
      throw apiError("ACTION_NOT_AVAILABLE", "Full-control permission is required.");
    }
    const action = String(input?.action ?? "");
    if (!["undo", "open-diff", "open-finder"].includes(action)) {
      throw apiError("INVALID_REQUEST", "Unsupported turn action.");
    }
    const key = String(context.idempotencyKey ?? "").trim();
    if (!key) throw apiError("INVALID_REQUEST", "Idempotency-Key is required.");
    const requestHash = createHash("sha256").update(stableJson({ sessionId, turnId, action })).digest("hex");
    const existing = this.store.getWebOperation(context.webSession.device.id, key);
    if (existing) return replayOperation(existing, requestHash);
    const createdAt = this.clock().toISOString();
    const operation = this.store.createWebOperation({
      id: randomUUID(), deviceId: context.webSession.device.id, idempotencyKey: key,
      requestHash, sessionId, createdAt
    });
    try {
      const result = await this.performTurnAction(sessionId, turnId, action);
      const response = actionResponse(operation.id, "succeeded", true, this.eventCursor(), result);
      this.store.completeWebOperation(operation.id, {
        status: "succeeded", sessionRevision: response.sessionRevision, result: response.result,
        updatedAt: this.clock().toISOString()
      });
      return response;
    } catch (error) {
      this.store.completeWebOperation(operation.id, {
        status: "failed", result: {}, error: { code: error.code ?? "INTERNAL_ERROR", message: error.stderr || error.message },
        updatedAt: this.clock().toISOString()
      });
      throw error;
    }
  }

  collaborationOverview() {
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      ...publicCollaboration(this.getCollaborationOverview())
    };
  }

  collaborationTask(taskId) {
    const detail = this.getCollaborationTask(taskId);
    if (!detail) throw apiError("INVALID_REQUEST", "Collaboration task not found.");
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      ...publicCollaboration(detail)
    };
  }

  collaborationAction(input, context) {
    if (context.webSession.device.permission !== "full-control") {
      throw apiError("ACTION_NOT_AVAILABLE", "Full-control permission is required.");
    }
    const action = String(input?.action ?? "");
    const targetId = String(input?.targetId ?? "");
    if (!["task.cancel", "delivery.retry"].includes(action) || !targetId) {
      throw apiError("INVALID_REQUEST", "Unsupported Collaboration action.");
    }
    const key = String(context.idempotencyKey ?? "").trim();
    if (!key) throw apiError("INVALID_REQUEST", "Idempotency-Key is required.");
    const requestHash = createHash("sha256").update(stableJson({ action, targetId, reason: input.reason ?? null })).digest("hex");
    const existing = this.store.getWebOperation(context.webSession.device.id, key);
    if (existing) return replayOperation(existing, requestHash);
    const createdAt = this.clock().toISOString();
    const operation = this.store.createWebOperation({
      id: randomUUID(), deviceId: context.webSession.device.id, idempotencyKey: key,
      requestHash, sessionId: `collaboration:${targetId}`, createdAt
    });
    try {
      const result = this.performCollaborationAction({ action, targetId, reason: input.reason });
      const response = actionResponse(operation.id, "succeeded", true, this.eventCursor(), publicCollaboration(result));
      this.store.completeWebOperation(operation.id, {
        status: "succeeded", sessionRevision: response.sessionRevision, result: response.result,
        updatedAt: this.clock().toISOString()
      });
      return response;
    } catch (error) {
      this.store.completeWebOperation(operation.id, {
        status: "failed", result: {}, error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
        updatedAt: this.clock().toISOString()
      });
      throw error;
    }
  }

  async metadata(sessionId) {
    const session = this.listSessions().find((entry) => entry.id === sessionId);
    if (!session) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    const metadata = await this.getSessionMetadata(session);
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      sessionId,
      branch: nullableText(metadata.branch),
      avatarUrl: session.avatarPath ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/avatar` : null,
      accountUsage: publicUsage(metadata.accountUsage),
      contextUsage: publicUsage(metadata.contextUsage)
    };
  }

  avatar(sessionId) {
    const session = this.listSessions().find((entry) => entry.id === sessionId);
    if (!session) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    const path = nullableText(session.avatarPath);
    if (!path) throw apiError("SESSION_NOT_FOUND", "Session avatar not found.");
    return { path };
  }

  reorder(input, webSession) {
    if (webSession.device.permission !== "full-control") {
      throw apiError("ACTION_NOT_AVAILABLE", "Full-control permission is required to reorder Sessions.");
    }
    const ids = Array.isArray(input?.sessionIds)
      ? input.sessionIds.map(String).filter(Boolean)
      : [];
    if (!ids.length || new Set(ids).size !== ids.length) {
      throw apiError("INVALID_REQUEST", "A unique, non-empty Session order is required.");
    }
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      sessions: this.reorderSessions(ids).map((session) => sessionSummary(session, webSession.device.permission))
    };
  }

  async bootstrap(webSession) {
    const creation = await this.creationOptions();
    return parseApiV1(apiV1BootstrapResponseSchema, {
      apiVersion: API_V1_VERSION,
      environment: this.environmentName,
      serverTime: this.clock().toISOString(),
      eventCursor: this.eventCursor(),
      csrfToken: webSession.csrfToken,
      device: {
        id: webSession.device.id,
        name: webSession.device.name,
        permission: webSession.device.permission,
        createdAt: webSession.device.createdAt ?? webSession.createdAt,
        lastSeenAt: webSession.device.lastSeenAt ?? webSession.lastSeenAt ?? null
      },
      features: {
        attention: true,
        collaboration: true,
        diff: true,
        pwa: true,
        notifications: true
      },
      preferences: {
        language: "zh-Hans",
        theme: "system"
      },
      creation
    }, "API v1 bootstrap response");
  }

  async create(input, webSession) {
    if (webSession.device.permission !== "full-control") {
      throw apiError("ACTION_NOT_AVAILABLE", "Full-control permission is required to create a Session.");
    }
    const request = parseApiV1(apiV1CreateSessionRequestSchema, input, "API v1 create Session request");
    const options = await this.creationOptions();
    const workspace = options.workspaces.find((entry) => entry.path === request.workspace);
    if (!workspace) throw apiError("INVALID_REQUEST", "Choose a trusted workspace from the Mac.");
    const allowedModels = options.models[request.agent] ?? [];
    if (request.model && !allowedModels.some((model) => model.id === request.model)) {
      throw apiError("INVALID_REQUEST", "Choose a model provided by the Mac.");
    }
    const created = await this.createSession({
      ...request,
      cwd: workspace.path,
      source: {
        type: "web",
        deviceId: webSession.device.id
      }
    });
    return {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      session: sessionSummary(created, webSession.device.permission)
    };
  }

  sessions(webSession) {
    return parseApiV1(apiV1SessionsResponseSchema, {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      sessions: this.listSessions().map((session) => sessionSummary(session, webSession.device.permission))
    }, "API v1 sessions response");
  }

  async session(sessionId, webSession) {
    const detail = await this.getSession(sessionId);
    if (!detail) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    return parseApiV1(apiV1SessionResponseSchema, {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      session: sessionDetail(detail, webSession.device.permission)
    }, "API v1 session response");
  }

  async attention(webSession) {
    const summaries = this.listSessions();
    const details = await Promise.all(summaries.map(async (summary) => {
      try {
        return await this.getSession(summary.id);
      } catch {
        return summary;
      }
    }));
    const items = details.flatMap((session) =>
      attentionItemsForSession(
        session,
        webSession.device.permission,
        this.store.getWebAttentionReadAt(webSession.device.id, session.id)
      )
    ).sort(compareAttentionItems);
    return parseApiV1(apiV1AttentionResponseSchema, {
      apiVersion: API_V1_VERSION,
      eventCursor: this.eventCursor(),
      count: items.length,
      runningCount: summaries.filter((session) => session.status === "running").length,
      items
    }, "API v1 attention response");
  }

  markAttentionRead(sessionId, webSession) {
    const session = this.listSessions().find((entry) => entry.id === sessionId);
    if (!session) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    return {
      apiVersion: API_V1_VERSION,
      sessionId,
      readAt: this.store.markWebAttentionRead(
        webSession.device.id,
        sessionId,
        this.clock().toISOString()
      )
    };
  }

  operation(operationId, webSession) {
    const operation = this.store.getWebOperationById(webSession.device.id, operationId);
    if (!operation) throw apiError("ACTION_EXPIRED", "Operation not found or no longer available.");
    if (operation.status === "failed") {
      throw apiError(
        operation.error?.code ?? "INTERNAL_ERROR",
        operation.error?.message ?? "The operation failed."
      );
    }
    return actionResponse(
      operation.id,
      operation.status,
      operation.status !== "failed",
      operation.sessionRevision,
      operation.result
    );
  }

  async action(sessionId, input, context) {
    const request = parseApiV1(apiV1ActionRequestSchema, input, "API v1 action request");
    const idempotencyKey = String(context.idempotencyKey ?? "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw apiError("INVALID_REQUEST", "Idempotency-Key is required and must be at most 200 characters.");
    }
    assertActionPermission(context.webSession.device.permission, request.action);
    const summary = this.listSessions().find((entry) => entry.id === sessionId);
    if (!summary) throw apiError("SESSION_NOT_FOUND", "Session not found.");
    const available = availableActions(summary, context.webSession.device.permission)
      .find((entry) => entry.id === request.action);
    if (!available?.enabled) {
      throw apiError("ACTION_NOT_AVAILABLE", available?.reason ?? "This action is not available.");
    }

    const requestHash = createHash("sha256")
      .update(stableJson({ sessionId, request }))
      .digest("hex");
    let operation = this.store.getWebOperation(context.webSession.device.id, idempotencyKey);
    if (operation) return replayOperation(operation, requestHash);

    const createdAt = this.clock().toISOString();
    try {
      operation = this.store.createWebOperation({
        id: randomUUID(),
        deviceId: context.webSession.device.id,
        idempotencyKey,
        requestHash,
        sessionId,
        createdAt
      });
    } catch (error) {
      operation = this.store.getWebOperation(context.webSession.device.id, idempotencyKey);
      if (!operation) throw error;
      return replayOperation(operation, requestHash);
    }

    try {
      const result = await this.perform(sessionId, request, {
        source: {
          type: "web",
          deviceId: context.webSession.device.id,
          operationId: operation.id
        }
      });
      const sessionRevision = Number(result?.sessionRevision ?? this.eventCursor());
      const response = actionResponse(operation.id, "succeeded", true, sessionRevision, result ?? {});
      this.store.completeWebOperation(operation.id, {
        status: response.status,
        sessionRevision: response.sessionRevision,
        result: response.result,
        updatedAt: this.clock().toISOString()
      });
      return response;
    } catch (error) {
      this.store.completeWebOperation(operation.id, {
        status: "failed",
        result: {},
        error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
        updatedAt: this.clock().toISOString()
      });
      throw error;
    }
  }

  events(cursor) {
    const normalizedCursor = Number(cursor);
    if (!Number.isInteger(normalizedCursor) || normalizedCursor < 0) {
      throw apiError("INVALID_REQUEST", "Event cursor must be a non-negative integer.");
    }
    const latest = this.eventCursor();
    if (normalizedCursor > latest) {
      throw apiError("RESYNC_REQUIRED", "Event cursor is ahead of this server. Fetch a new snapshot.");
    }
    const retained = this.eventsAfter(normalizedCursor);
    const earliest = retained[0]?.id ?? null;
    if (normalizedCursor > 0 && earliest !== null && earliest > normalizedCursor + 1) {
      throw apiError("RESYNC_REQUIRED", "The requested event cursor is no longer retained. Fetch a new snapshot.");
    }
    return retained.map(eventEnvelope);
  }

  subscribe(listener) {
    return this.subscribeEvents((event) => listener(eventEnvelope(event)));
  }
}

export function sessionSummary(session, permission = "read-only") {
  return {
    id: String(session.id),
    title: String(session.title || "Untitled session"),
    agent: String(session.agent || providerLabel(session.external?.provider)),
    status: normalizeStatus(session.status),
    progress: clampProgress(session.progress),
    summary: String(session.summary ?? ""),
    suggestedOptions: normalizeOptions(session.suggestedOptions),
    suggestedPrompt: nullableText(session.suggestedPrompt),
    activityStatus: nullableText(session.activityStatus),
    updatedAt: timestamp(session.updatedAt),
    accent: VALID_ACCENTS.has(session.accent) ? session.accent : "cyan",
    archived: session.archived === true,
    pinned: session.pinned === true,
    sortOrder: Number.isFinite(Number(session.sortOrder)) ? Number(session.sortOrder) : null,
    avatarUrl: null,
    capabilities: publicCapabilities(session.capabilities),
    availableActions: availableActions(session, permission),
    external: publicExternal(session.external)
  };
}

export function sessionDetail(session, permission = "read-only") {
  const summary = sessionSummary(session, permission);
  const items = Array.isArray(session.items) ? session.items.map(normalizeItem) : [];
  return {
    ...summary,
    source: nullableText(session.source ?? session.external?.source),
    connectionStatus: nullableText(session.connectionStatus ?? session.external?.connectionStatus),
    currentModel: nullableText(session.currentModel ?? session.external?.currentModel),
    currentReasoningLevel: nullableText(
      session.currentReasoningLevel ?? session.external?.currentReasoningLevel
    ),
    cwd: nullableText(session.cwd ?? session.external?.cwd),
    createdAt: timestamp(session.createdAt ?? session.updatedAt),
    canSend: permission !== "read-only" && session.capabilities?.canSend !== false,
    sendUnavailableReason: permission === "read-only" ? "This device has read-only access." : null,
    turnCount: Number.isInteger(session.turnCount)
      ? Math.max(0, session.turnCount)
      : new Set(items.map((item) => item.turnId)).size,
    items
  };
}

export function availableActions(session, permission = "read-only") {
  const capabilities = publicCapabilities(session.capabilities);
  const definitions = [
    ["message.send", capabilities.canSend === true, "This session cannot accept messages.", "low"],
    ["session.interrupt", capabilities.canInterrupt === true, "No active run can be interrupted.", "medium"],
    ["session.reconnect", capabilities.canReconnect === true, "This provider cannot reconnect.", "low"],
    ["session.archive", session.archived !== true, "Session is already archived.", "medium"],
    ["session.unarchive", session.archived === true, "Session is not archived.", "low"],
    ["session.pin", true, null, "low"],
    ["session.rename", true, null, "low"],
    ["session.delete", true, null, "high"],
    ["session.model.set", capabilities.canSwitchModel === true, "This provider cannot switch model.", "medium"],
    ["session.reasoning.set", capabilities.canSwitchReasoning === true, "This provider cannot switch reasoning.", "medium"],
    ["session.permissions.set", session.external?.provider === "codex-app-server", "Permissions are fixed for this provider.", "high"],
    ["choice.respond", hasPendingChoice(session), "There is no pending choice.", "medium"],
    ["approval.respond", hasPendingApproval(session), "There is no pending approval.", "high"],
    ["collaboration.confirm", hasPendingConfirmation(session), "There is no pending collaboration confirmation.", "high"],
    ["collaboration.reject", hasPendingConfirmation(session), "There is no pending collaboration confirmation.", "medium"]
  ];
  return definitions.map(([id, capabilityEnabled, reason, risk]) => {
    const permissionEnabled = actionAllowed(permission, id);
    const implemented = IMPLEMENTED_ACTIONS.has(id);
    return {
      id,
      enabled: permissionEnabled && capabilityEnabled && implemented,
      risk,
      reason: !permissionEnabled
        ? "This device does not have permission for this action."
        : (!implemented ? "This action is not available from the Web client yet." : (capabilityEnabled ? null : reason))
    };
  });
}

export function attentionItemsForSession(session, permission = "read-only", readAt = null) {
  const summary = sessionSummary(session, permission);
  const result = [];
  const pendingItems = Array.isArray(session.items)
    ? session.items.filter((item) => !["complete", "completed", "resolved", "sent"].includes(item.status))
    : [];
  const approval = pendingItems.find((item) => item.type === "approval");
  const choice = pendingItems.find((item) => item.type === "choice")
    ?? (summary.suggestedOptions?.length ? { id: null, text: summary.suggestedPrompt } : null);
  const confirmation = pendingItems.find((item) =>
    item.collaborationConfirmationId && item.collaborationConfirmationStatus === "pending"
  );

  if (approval) {
    result.push(attentionItem(summary, {
      kind: "high-risk-approval",
      priority: 1,
      contextItemId: approval.id,
      summary: approval.text,
      actionContext: {
        itemId: approval.id,
        optionId: approval.options?.find((option) => option.role === "approve")?.id ?? null
      }
    }));
  }
  if (confirmation) {
    result.push(attentionItem(summary, {
      kind: "collaboration-confirmation",
      priority: 2,
      contextItemId: confirmation.id,
      summary: confirmation.presentationText ?? confirmation.text,
      actionContext: { confirmationId: confirmation.collaborationConfirmationId }
    }));
  }
  if (choice || (session.status === "blocked" && !approval && !confirmation)) {
    result.push(attentionItem(summary, {
      kind: "input-required",
      priority: 3,
      contextItemId: choice?.id ?? null,
      summary: choice?.text ?? summary.suggestedPrompt ?? summary.summary
    }));
  }
  if (session.status === "failed") {
    result.push(attentionItem(summary, {
      kind: "failure",
      priority: 4,
      summary: summary.summary
    }));
  }
  const connectionStatus = String(
    session.connectionStatus ?? session.external?.connectionStatus ?? ""
  ).toLowerCase();
  if (connectionStatus.includes("disconnect") || connectionStatus.includes("offline")) {
    result.push(attentionItem(summary, {
      kind: "disconnected",
      priority: 4,
      summary: session.connectionStatus ?? session.external?.connectionStatus ?? summary.summary
    }));
  }
  const regularApproval = !approval && pendingItems.find((item) =>
    item.type === "permission" || item.type === "confirmation"
  );
  if (regularApproval) {
    result.push(attentionItem(summary, {
      kind: "approval",
      priority: 5,
      contextItemId: regularApproval.id,
      summary: regularApproval.text
    }));
  }
  if (session.status === "complete" && (!readAt || Date.parse(readAt) < Date.parse(summary.updatedAt))) {
    result.push(attentionItem(summary, {
      kind: "completed-unread",
      priority: 6,
      summary: summary.summary
    }));
  }
  return result;
}

function attentionItem(summary, input) {
  return {
    id: `${summary.id}:${input.kind}:${input.contextItemId ?? "session"}`,
    kind: input.kind,
    priority: input.priority,
    sessionId: summary.id,
    sessionTitle: summary.title,
    agent: summary.agent,
    summary: String(input.summary ?? ""),
    updatedAt: summary.updatedAt,
    contextItemId: input.contextItemId ?? null,
    actionContext: input.actionContext ?? {},
    availableActions: summary.availableActions
  };
}

function compareAttentionItems(left, right) {
  return left.priority - right.priority
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function replayOperation(operation, requestHash) {
  if (operation.requestHash !== requestHash) {
    throw apiError("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different request.");
  }
  if (operation.status === "failed") {
    throw apiError(
      operation.error?.code ?? "INTERNAL_ERROR",
      operation.error?.message ?? "The previous operation failed."
    );
  }
  return actionResponse(
    operation.id,
    operation.status,
    true,
    operation.sessionRevision,
    operation.result
  );
}

function eventEnvelope(event) {
  return parseApiV1(apiV1EventSchema, {
    schemaVersion: 1,
    eventId: Number(event.id),
    serverTime: timestamp(event.createdAt),
    type: String(event.type || "Unknown"),
    sessionId: nullableText(event.sessionId),
    sessionRevision: event.sessionRevision == null ? null : Math.max(0, Number(event.sessionRevision)),
    payload: isPlainObject(event.payload) ? event.payload : { value: event.payload }
  }, "API v1 event");
}

function actionResponse(operationId, status, accepted, sessionRevision, result) {
  return parseApiV1(apiV1ActionResponseSchema, {
    apiVersion: API_V1_VERSION,
    operationId,
    status,
    accepted,
    sessionRevision: sessionRevision == null ? null : Math.max(0, Number(sessionRevision)),
    result: isPlainObject(result) ? result : { value: result }
  }, "API v1 action response");
}

function assertActionPermission(permission, action) {
  if (!actionAllowed(permission, action)) {
    throw apiError("ACTION_NOT_AVAILABLE", "This device does not have permission for this action.");
  }
}

function actionAllowed(permission, action) {
  if (permission === "full-control") return FULL_CONTROL_ACTIONS.has(action) || REPLY_ACTIONS.has(action);
  if (permission === "reply") return REPLY_ACTIONS.has(action);
  return false;
}

function hasPendingChoice(session) {
  return Array.isArray(session.suggestedOptions) && session.suggestedOptions.length > 0;
}

function hasPendingApproval(session) {
  return Array.isArray(session.items) && session.items.some((item) =>
    item.type === "approval"
    && !["complete", "completed", "resolved", "sent"].includes(String(item.status ?? "").toLowerCase())
  );
}

function hasPendingConfirmation(session) {
  return Array.isArray(session.items) && session.items.some((item) =>
    item.collaborationConfirmationId && item.collaborationConfirmationStatus === "pending"
  );
}

function publicCapabilities(capabilities) {
  const value = isPlainObject(capabilities) ? capabilities : {};
  return {
    canSend: value.canSend !== false,
    canSwitchModel: value.canSwitchModel === true,
    canSwitchReasoning: value.canSwitchReasoning === true,
    canInterrupt: value.canInterrupt === true,
    canReconnect: value.canReconnect === true
  };
}

function publicExternal(external) {
  if (!isPlainObject(external)) return null;
  return {
    provider: String(external.provider || "unknown"),
    threadId: nullableText(external.threadId),
    sessionId: nullableText(external.sessionId),
    agentSessionId: nullableText(external.agentSessionId),
    connectionStatus: nullableText(external.connectionStatus),
    currentModel: nullableText(external.currentModel),
    currentReasoningLevel: nullableText(external.currentReasoningLevel),
    cwd: nullableText(external.cwd),
    sandbox: nullableText(external.sandbox),
    approvalPolicy: nullableText(external.approvalPolicy),
    source: nullableText(external.source)
  };
}

function normalizeItem(item, index) {
  return {
    id: String(item?.id || `item-${index}`),
    turnId: String(item?.turnId ?? ""),
    turnStatus: String(item?.turnStatus ?? ""),
    type: String(item?.type || "message"),
    title: String(item?.title ?? ""),
    text: String(item?.text ?? ""),
    options: normalizeOptions(item?.options),
    status: nullableText(item?.status),
    createdAt: item?.createdAt ? timestamp(item.createdAt) : null,
    sourceType: nullableText(item?.sourceType),
    localVisibility: nullableText(item?.localVisibility),
    workItemId: nullableText(item?.workItemId),
    collaborationTaskId: nullableText(item?.collaborationTaskId),
    presentationRole: nullableText(item?.presentationRole),
    presentationText: nullableText(item?.presentationText),
    collaborationDirection: nullableText(item?.collaborationDirection),
    collaborationSenderAgentId: nullableText(item?.collaborationSenderAgentId),
    collaborationSenderName: nullableText(item?.collaborationSenderName),
    collaborationRecipientAgentId: nullableText(item?.collaborationRecipientAgentId),
    collaborationRecipientName: nullableText(item?.collaborationRecipientName),
    collaborationTaskTitle: nullableText(item?.collaborationTaskTitle),
    collaborationMessageKind: nullableText(item?.collaborationMessageKind),
    collaborationProcessingStatus: nullableText(item?.collaborationProcessingStatus),
    collaborationConfirmationId: nullableText(item?.collaborationConfirmationId),
    collaborationConfirmationStatus: nullableText(item?.collaborationConfirmationStatus),
    collaborationAcceptanceCriteria: Array.isArray(item?.collaborationAcceptanceCriteria)
      ? item.collaborationAcceptanceCriteria.map(String)
      : null,
    fileChanges: Array.isArray(item?.fileChanges)
      ? item.fileChanges.filter(isPlainObject).map((change) => ({
        path: String(change.path || ""),
        kind: String(change.kind || "modify")
      })).filter((change) => change.path)
      : null,
    turnDiff: nullableText(item?.turnDiff)
  };
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return null;
  return options.map((option, index) => ({
    ...option,
    id: String(option?.id || index),
    label: String(option?.label || option?.title || option?.id || index),
    role: nullableText(option?.role),
    index: Number.isInteger(option?.index) ? option.index : index,
    selected: typeof option?.selected === "boolean" ? option.selected : null
  }));
}

function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : "complete";
}

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function timestamp(value) {
  const date = new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function nullableText(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function publicUsage(value) {
  if (!isPlainObject(value)) return null;
  const allowed = /^(available|provider|model|message|primary|secondary|credits|context|input|output|total|used|remaining|limit|percent|window|reset|tokens|tokenCount)$|(?:Percent|Tokens|TokenCount|Used|Remaining|Limit|Window|Reset)$/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => allowed.test(key))
    .map(([key, entry]) => [
      key,
      isPlainObject(entry) ? publicUsage(entry) : (
        Array.isArray(entry)
          ? entry.filter((item) => ["string", "number", "boolean"].includes(typeof item))
          : (["string", "number", "boolean"].includes(typeof entry) || entry == null ? entry : null)
      )
    ]));
}

function publicCollaboration(value) {
  if (Array.isArray(value)) return value.map(publicCollaboration);
  if (!isPlainObject(value)) return value;
  const allowed = new Set([
    "agents", "services", "tasks", "task", "deliveries", "messages", "artifacts", "events",
    "agentId", "name", "description", "status", "capabilities", "updatedAt", "createdAt",
    "serviceId", "ownerAgentId", "currentVersion",
    "taskId", "title", "type", "summary", "initiatorAgentId", "recipientAgentId",
    "acceptanceCriteria", "iteration", "maxIterations", "parentTaskId", "contextId",
    "messageId", "senderAgentId", "recipientAgentId", "messageType", "body", "evidence",
    "artifactId", "kind", "uri", "label", "sequence", "eventType", "payload",
    "deliveryId", "attemptCount", "nextAttemptAt", "deliveredAt", "lastError", "targetTurnId"
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => allowed.has(key))
    .map(([key, entry]) => [key, publicCollaboration(entry)]));
}

function providerLabel(provider) {
  return provider === "claude-sdk" ? "Claude Code" : "Codex";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
