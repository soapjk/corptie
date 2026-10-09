import { projectTaskDeletionNotification } from "./worktreeIntegrationJobService.mjs";
import { boundedUnicodeText } from "../utils/unicodeText.mjs";
import { createHash } from "node:crypto";
import { ensureReliableMessageSchema, acceptReliableMessage, reliableReceipt } from "./clientReliableMessages.mjs";
import { ClientImageUploads, imageUploadPolicy } from "./clientImageUploads.mjs";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { validateSessionCommand, sessionCommandNeedsConfirmation } from "../commands/sessionCommandCatalog.mjs";
import { parseSlashCommand } from "../commands/unifiedCommands.mjs";
import { createClientTask, clientTaskCreationCatalog } from "./clientTaskCreation.mjs";
import { clientDiscussionOptions, openClientDiscussion } from "./clientWorkDiscussion.mjs";
import { clientTaskManagement, clientTaskDeletionPlan, clientWorkManagement, clientTaskCommand, clientWorkCommand, clientWorkCreationOptions, createClientWork } from "./clientEntityCommands.mjs";
import { publicToolExecution } from "../utils/toolExecutionProjection.mjs";
import { publicChangeSet } from "../utils/changeSetProjection.mjs";
import { publicUserInput, validateInteractionAnswers, withSubmittedUserInputAnswers } from "./interactionInput.mjs";

function approvalMetadata(item) {
  try {
    const value = JSON.parse(item.rawMetadataJSON ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function approvalSubmission(item) {
  return approvalMetadata(item).approvalSubmission ?? null;
}

export function approvalRequestIsCurrent(item, bindingId, input, source) {
  if (!item || !["choice", "approval"].includes(item.type)
    || (item.bindingId && bindingId && item.bindingId !== bindingId)) return false;
  if (source?.type === "remote-client" && typeof source.deviceId === "string") {
    return item.status === "dispatching" && approvalSubmission(item)?.optionId === input?.optionId;
  }
  return item.status === "pending";
}

function publicExecutionPlan(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.planId !== "string"
    || !Number.isSafeInteger(value.revision) || !Array.isArray(value.steps)
    || value.steps.length > 200) return null;
  return {
    schemaVersion: 1,
    planId: value.planId,
    revision: value.revision,
    lifecycle: typeof value.lifecycle === "string" ? value.lifecycle : "unknown",
    explanation: typeof value.explanation === "string" ? boundedUnicodeText(value.explanation, 2_000) : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    steps: value.steps.map((step, ordinal) => ({
      stepId: boundedUnicodeText(step?.stepId ?? "", 200),
      ordinal,
      text: boundedUnicodeText(step?.text ?? "", 2_000),
      status: typeof step?.status === "string" ? step.status : "unknown"
    }))
  };
}

const PUBLIC_PRESENTATION_STRING_FIELDS = [
  "turnStatus", "title", "presentationRole", "presentationText",
  "sourceType", "localVisibility", "processingError",
  "processStartedAt", "processEndedAt",
  "collaborationDirection", "collaborationSenderAgentId", "collaborationSenderName",
  "collaborationRecipientAgentId", "collaborationRecipientName",
  "collaborationInitiatorSessionId", "collaborationInitiatorSessionTitle",
  "collaborationInitiatorSessionKind", "collaborationRecipientSessionId",
  "collaborationRecipientSessionTitle", "collaborationRecipientSessionKind",
  "collaborationSourceWorkId", "collaborationSourceWorkName",
  "collaborationTargetWorkId", "collaborationTargetWorkName",
  "collaborationSourceTaskId", "collaborationTargetTaskId",
  "collaborationRelation", "collaborationRouteStatus", "collaborationRequestTitle",
  "collaborationMessageKind", "collaborationProcessingStatus",
  "collaborationConfirmationId", "collaborationConfirmationStatus",
  "collaborationAuthorizationKind", "collaborationChannelId",
  "automationId", "automationName", "automationTriggerType", "automationEventType",
  "automationEventSource", "automationRunId", "automationEventOccurredAt",
  "automationRunStatus", "automationRunError", "messageOrigin",
  "automationScheduleType", "automationRunAt", "automationNextRunAt", "automationExpiresAt",
  "systemEventKind", "systemEventReason", "systemEventSource"
];

function publicPresentationString(value, maximumLength = 4_000) {
  return typeof value === "string" ? boundedUnicodeText(value, maximumLength) : null;
}

function publicClientMessage(item) {
  const message = {
    id: item.id, turnId: item.turnId ?? null, type: item.type,
    text: typeof item.text === "string" ? item.text : "", status: item.status ?? null,
    createdAt: item.createdAt ?? null,
    userMessageStatus: item.userMessageStatus ?? null, queuePosition: item.queuePosition ?? null,
    deletionAvailable: item.deletionAvailable === true,
    queuedMessageTaskId: item.type === "userMessage" && item.userMessageStatus === "queued"
      && typeof item.taskId === "string" ? item.taskId : null,
    ...Object.fromEntries(PUBLIC_PRESENTATION_STRING_FIELDS.map(key => [key,
      publicPresentationString(item[key], key === "presentationText" ? 200_000 : 4_000)])),
    collaborationRoutingVersion: Number.isSafeInteger(item.collaborationRoutingVersion)
      ? item.collaborationRoutingVersion : null,
    collaborationAcceptanceCriteria: Array.isArray(item.collaborationAcceptanceCriteria)
      ? item.collaborationAcceptanceCriteria.filter(value => typeof value === "string")
        .slice(0, 50).map(value => value.slice(0, 4_000)) : null,
    ...Object.fromEntries([
      "automationIntervalSeconds", "automationConditionCheckIntervalSeconds",
      "automationProcessPollIntervalSeconds"
    ].map(key => [key, typeof item[key] === "number" && Number.isFinite(item[key]) ? item[key] : null])),
    images: Array.isArray(item.images) ? item.images
      .filter(image => image && typeof image.managedPath === "string" && image.managedPath)
      .slice(0, 8)
      .map(image => ({ managedPath: image.managedPath,
        fileName: typeof image.fileName === "string" ? image.fileName : null,
        mimeType: typeof image.mimeType === "string" ? image.mimeType : null,
        byteLength: Number.isSafeInteger(image.byteLength) ? image.byteLength : null })) : [],
    executionPlan: item.type === "executionPlan" ? publicExecutionPlan(item.executionPlan) : null,
    toolExecution: publicToolExecution(item.toolExecution),
    changeSet: publicChangeSet(item.changeSet),
    userInput: item.type === "userInput" ? publicUserInput(item.userInput) : null,
    options: ["choice", "approval"].includes(item.type) && Array.isArray(item.options)
      ? item.options.slice(0, 12).filter(option => option && typeof option.id === "string" && typeof option.label === "string")
        .map(option => ({ id: option.id.slice(0, 200), label: option.label.slice(0, 200),
          role: typeof option.role === "string" ? option.role.slice(0, 40) : null,
          selected: option.selected === true })) : null,
  };
  // Optional fields decode identically when absent. Keep all populated data.
  return Object.fromEntries(Object.entries(message).filter(([, value]) => value != null));
}

/** v1 text messaging + stop commands. Provider-neutral callbacks, durable at-most-once dispatch. */
export class ClientSessionAPI {
  constructor({ deleteUserMessage = null, cancelQueuedMessage = null, quickMessages = null, store, readWindow, send, stop, actions, resolveSession = id => id, composer = null, images = null, schedule = null, conversationCommands = null, taskCreation = null, workDiscussion = null, markRead = null, readiness = null, usage = null, entityCommands = null, respondToApproval = null, respondToUserInput = null, respondToCollaborationConfirmation = null, respondToSessionChannelRequest = null, onReceiptChanged = null, inspector = null, admitReliableMessage = null }) {
    this.deleteUserMessage = deleteUserMessage;
    this.cancelQueuedMessageHandler = cancelQueuedMessage;
    this.admitReliableMessage = admitReliableMessage;
    this.reliableMessagesInFlight = new Map();
    ensureReliableMessageSchema(store);
    this.imageUploads = new ClientImageUploads(store);
    this.quickMessageReader = quickMessages;
    this.inspector = inspector;
    Object.assign(this, { store, readWindow, send, stop, actions, resolveSession, composer, images, schedule, conversationCommands });
    // Optional host projections: Session readiness (desktop ThreadMetaView light) and usage (context / quota).
    this.readiness = readiness;
    this.usageReader = usage;
    // Host callback so read receipts publish through the same state-sync path as the desktop route.
    this.markRead = markRead ?? ((sessionId, throughSequence) => store.markSessionMessagesRead(sessionId, throughSequence));
    this.taskCreation = taskCreation;
    this.workDiscussion = workDiscussion;
    // Host Work / Task management services (desktop entity routes); absent hosts answer CAPABILITY_UNSUPPORTED.
    this.entityCommands = entityCommands;
    this.respondToApproval = respondToApproval;
    this.respondToUserInput = respondToUserInput;
    this.respondToCollaborationConfirmation = respondToCollaborationConfirmation;
    this.respondToSessionChannelRequest = respondToSessionChannelRequest;
    this.onReceiptChanged = onReceiptChanged;
    store.db.run(`CREATE TABLE IF NOT EXISTS client_command_receipts (
      device_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(device_id, request_id))`);
    if (!store.selectAll("PRAGMA table_info(client_command_receipts)").some(column => column.name === "result_json")) {
      store.db.run("ALTER TABLE client_command_receipts ADD COLUMN result_json TEXT");
    }
    this.inFlight = new Set();
    this.approvalsInFlight = new Set();
    this.userInputInFlight = new Set();
    this.collaborationConfirmationsInFlight = new Set();
  }

  session(id) {
    const sessionId = this.resolveSession(id);
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (!session || session.archived === true) throw deviceError("SESSION_NOT_AVAILABLE", 404);
    return { sessionId, session };
  }

  async cancelQueuedMessage(identity, id, input) {
    const { sessionId } = this.session(id);
    if (!this.cancelQueuedMessageHandler) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (typeof input?.taskId !== "string" || !input.taskId.trim() || input.taskId.length > 512) {
      throw deviceError("INVALID_TASK_ID", 400);
    }
    try {
      await this.cancelQueuedMessageHandler(sessionId, input.taskId);
    } catch (error) {
      if (error?.code === "SESSION_BUSY") throw deviceError("MESSAGE_NOT_QUEUED", 409);
      throw error;
    }
    return { schemaVersion: 1, status: "cancelled" };
  }

  async deleteMessage(identity, id, messageId) {
    const { sessionId } = this.session(id);
    if (!this.deleteUserMessage) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    return this.deleteUserMessage(sessionId, messageId);
  }

  createTask(identity, sourceSessionId, input, revalidateIdentity = null) {
    return createClientTask(this, identity, sourceSessionId, input, revalidateIdentity);
  }
  discussionOptions(identity, workId) { return clientDiscussionOptions(this, identity, workId); }
  openDiscussion(identity, workId, input, revalidateIdentity = null) {
    return openClientDiscussion(this, identity, workId, input, revalidateIdentity);
  }
  taskManagement(identity, taskId) { return clientTaskManagement(this, identity, taskId); }
  taskDeletionNotification(_identity, operationId) {
    if (typeof operationId !== "string" || !operationId || operationId.length > 512) throw deviceError("INVALID_OPERATION_ID", 400);
    const operation = this.store.getTaskDeletionOperation(operationId);
    if (!operation) throw deviceError("TASK_DELETE_OPERATION_NOT_FOUND", 404);
    return { notification: projectTaskDeletionNotification(operation) };
  }
  taskDeletionPlan(identity, taskId) { return clientTaskDeletionPlan(this, identity, taskId); }
  workManagement(identity, workId) { return clientWorkManagement(this, identity, workId); }
  workCreationOptions() { return clientWorkCreationOptions(this); }
  createWork(identity, input, revalidateIdentity = null) {
    return createClientWork(this, identity, input, revalidateIdentity);
  }
  taskCommand(identity, taskId, command, input, revalidateIdentity = null) {
    return clientTaskCommand(this, identity, taskId, command, input, revalidateIdentity);
  }
  workCommand(identity, workId, command, input, revalidateIdentity = null) {
    return clientWorkCommand(this, identity, workId, command, input, revalidateIdentity);
  }
  taskCreationOptions(identity, sourceSessionId, query) {
    return clientTaskCreationCatalog(this, identity, sourceSessionId, query);
  }

  async messages(identity, sessionId, query) {
    sessionId = this.session(sessionId).sessionId;
    if ([...query.keys()].some(k => !["limit", "before"].includes(k))
        || query.getAll("limit").length > 1 || query.getAll("before").length > 1) throw deviceError("INVALID_QUERY", 400);
    const rawLimit = query.get("limit") ?? "40";
    if (!/^[1-9]$|^[1-4][0-9]$|^50$/.test(rawLimit)) throw deviceError("INVALID_LIMIT", 400);
    const limit = Number(rawLimit), anchor = query.get("before");
    if (anchor != null && (!anchor || anchor.length > 1024)) throw deviceError("INVALID_ANCHOR", 400);
    return this.messageWindow(sessionId, { limit, anchor });
  }

  async quickMessages(identity, sessionId) {
    const resolved = this.session(sessionId);
    if (!this.quickMessageReader) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    return this.quickMessageReader(resolved.sessionId);
  }

  async messageWindow(sessionId, { limit, anchor = null }) {
    const window = await this.readWindow(sessionId, { anchorKind: "item", anchorId: anchor,
      before: limit, after: 0, limit: limit + (anchor ? 1 : 0) });
    if (anchor && (window.anchor?.status === "missing" || !window.items.some(item => item.id === anchor))) throw deviceError("ANCHOR_NOT_FOUND", 409);
    // The shared timeline window may include newer rows even for after=0.
    // v1 history pagination is strictly before the anchor, never a mixed window.
    const candidates = anchor ? window.items.slice(0, window.items.findIndex(item => item.id === anchor)) : window.items;
    const projected = candidates.slice(-limit).map(publicClientMessage);
    // Bound normal history pages by bytes as well as rows. Keep an oversized
    // individual item intact (the existing 8MiB safety limit still applies),
    // rather than silently truncating its text or structured presentation.
    let bytes = 1024, start = projected.length;
    while (start > 0) {
      const nextBytes = Buffer.byteLength(JSON.stringify(projected[start - 1])) + 1;
      if (start < projected.length && bytes + nextBytes > 128 * 1024) break;
      bytes += nextBytes;
      start -= 1;
    }
    const items = projected.slice(start);
    const hasEarlier = window.hasEarlier === true || start > 0;
    const result = { schemaVersion: 1, sessionId, revision: window.revision, items,
      hasEarlier, nextBefore: hasEarlier && items.length ? items[0].id : null };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw deviceError("MESSAGE_WINDOW_TOO_LARGE", 413);
    return result;
  }

  async realtimeTimeline(identity, id, after = null, { includeDetail = true, coalesce = false } = {}) {
    const { sessionId } = this.session(id);
    // Resident timelines carry durable usage even when they are not selected.
    // Never call a Provider for every streamed message or background bootstrap.
    let usage = null;
    try { usage = await this.usage(identity, sessionId, { cached: true }); } catch {}
    const localRevision = Number(after);
    if (Number.isSafeInteger(localRevision) && localRevision > 0) {
      const envelope = this.store.sessionTimelineChangesAfter(sessionId, localRevision, 200);
      if (!envelope.snapshotRequired) {
        const lastChanges = new Map(envelope.changes.map((change, index) => [change.itemId, index]));
        return {
          schemaVersion: 2,
          kind: "delta",
          sessionId,
          ...envelope,
          usage,
          changes: envelope.changes.map((change, index) => coalesce && lastChanges.get(change.itemId) !== index
            ? { revision: change.revision, itemId: change.itemId, operation: "noop", item: null }
            : { ...change, item: change.item ? publicClientMessage(change.item) : null })
        };
      }
    }
    // Match the desktop repository window: keep a wider bounded source window
    // resident, then let each client expose the last 20 semantic message
    // weights. A 50-row raw window can collapse to only one or two cards when
    // a turn contains many reasoning/tool events.
    const messages = await this.messageWindow(sessionId, { limit: 200 });
    const capabilities = this.capabilities(identity, sessionId);
    let composer = null;
    if (includeDetail) {
      try { usage = await this.usage(identity, sessionId); } catch {}
      try { composer = await this.configuration(identity, sessionId); } catch {}
    }
    return { schemaVersion: 2, kind: "snapshot", sessionId,
      revision: messages.revision ?? this.store.sessionTimelineRevision(sessionId),
      messages, capabilities, usage, composer };
  }

  async approval(identity, id, input, revalidateIdentity = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["itemId", "optionId"].includes(key))
      || typeof input.itemId !== "string" || !input.itemId || input.itemId.length > 300
      || typeof input.optionId !== "string" || !input.optionId || input.optionId.length > 200) {
      throw deviceError("INVALID_APPROVAL", 400);
    }
    const { sessionId } = this.session(id);
    const item = this.store.getSessionItem(sessionId, input.itemId);
    if (!item || !["choice", "approval"].includes(item.type)) {
      throw deviceError("APPROVAL_NOT_PENDING", 409);
    }
    const previousSubmission = approvalSubmission(item);
    if (item.status === "submitted" && previousSubmission?.optionId === input.optionId) {
      return { schemaVersion: 1, sessionId, itemId: item.id, status: "submitted" };
    }
    if (item.status === "dispatching" || item.status === "unknown") {
      throw deviceError("APPROVAL_OUTCOME_UNCERTAIN", 409);
    }
    if (item.status !== "pending") throw deviceError("APPROVAL_NOT_PENDING", 409);
    const option = item.options?.find(candidate => candidate.id === input.optionId);
    if (!option) throw deviceError("INVALID_APPROVAL_OPTION", 400);
    if (!this.respondToApproval) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (revalidateIdentity) {
      const current = revalidateIdentity();
      if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    }
    const key = `${sessionId}:${item.id}`;
    if (this.approvalsInFlight.has(key)) throw deviceError("APPROVAL_IN_PROGRESS", 409);
    this.approvalsInFlight.add(key);
    const metadata = approvalMetadata(item);
    const submissionMetadata = JSON.stringify({ ...metadata, approvalSubmission: { optionId: option.id } });
    this.store.upsertTimelineItemProjection(sessionId, {
      ...item, status: "dispatching", rawMetadataJSON: submissionMetadata
    });
    try {
      await this.respondToApproval(sessionId, {
        itemId: item.id, choiceId: item.id, optionId: option.id,
        approved: option.role === "approve" || option.role === "approve_always"
      }, { type: "remote-client", deviceId: identity.deviceId });
      const current = this.store.getSessionItem(sessionId, item.id);
      if (current?.status === "dispatching") {
        this.store.upsertTimelineItemProjection(sessionId, { ...current, status: "submitted" });
      }
    } catch (error) {
      const current = this.store.getSessionItem(sessionId, item.id);
      if (current?.status === "dispatching") {
        this.store.upsertTimelineItemProjection(sessionId, { ...current, status: "unknown" });
      }
      throw error;
    } finally { this.approvalsInFlight.delete(key); }
    return { schemaVersion: 1, sessionId, itemId: item.id, status: "submitted" };
  }

  async userInput(identity, id, input, revalidateIdentity = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["itemId", "answers", "action"].includes(key))
      || typeof input.itemId !== "string" || !input.itemId || input.itemId.length > 300) {
      throw deviceError("INVALID_USER_INPUT", 400);
    }
    const { sessionId } = this.session(id);
    const item = this.store.getSessionItem(sessionId, input.itemId);
    if (!item || item.type !== "userInput") throw deviceError("USER_INPUT_NOT_PENDING", 409);
    if (item.status === "submitted") {
      return { schemaVersion: 1, sessionId, itemId: item.id, status: "submitted" };
    }
    if (["dispatching", "unknown"].includes(item.status)) {
      throw deviceError("USER_INPUT_OUTCOME_UNCERTAIN", 409);
    }
    if (item.status !== "pending") throw deviceError("USER_INPUT_NOT_PENDING", 409);
    if ((input.action != null && !["submit", "cancel"].includes(input.action))
      || (input.action === "cancel" ? item.userInput?.canCancel !== true : !validateInteractionAnswers(item.userInput, input.answers))) {
      throw deviceError("INVALID_USER_INPUT_ANSWER", 400);
    }
    if (!this.respondToUserInput) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (revalidateIdentity) {
      const current = revalidateIdentity();
      if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    }
    const key = `${sessionId}:${item.id}`;
    if (this.userInputInFlight.has(key)) throw deviceError("USER_INPUT_IN_PROGRESS", 409);
    this.userInputInFlight.add(key);
    this.store.upsertTimelineItemProjection(sessionId, { ...item, status: "dispatching" });
    try {
      await this.respondToUserInput(sessionId, {
        itemId: item.id, answers: input.answers, ...(input.action ? { action: input.action } : {})
      }, { type: "remote-client", deviceId: identity.deviceId });
      const current = this.store.getSessionItem(sessionId, item.id);
      if (current?.status === "dispatching") {
        this.store.upsertTimelineItemProjection(sessionId, {
          ...(input.action === "cancel" ? current : withSubmittedUserInputAnswers(current, input.answers)),
          status: input.action === "cancel" ? "cancelled" : "submitted"
        });
      }
    } catch (error) {
      const current = this.store.getSessionItem(sessionId, item.id);
      if (current?.status === "dispatching") {
        this.store.upsertTimelineItemProjection(sessionId, {
          ...current, status: error?.code === "INVALID_USER_INPUT_ANSWER" ? "pending" : error?.code === "USER_INPUT_NOT_PENDING" ? "expired" : "unknown"
        });
      }
      throw error;
    } finally { this.userInputInFlight.delete(key); }
    return { schemaVersion: 1, sessionId, itemId: item.id, status: input.action === "cancel" ? "cancelled" : "submitted" };
  }

  async collaborationConfirmation(identity, id, input, revalidateIdentity = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["itemId", "decision"].includes(key))
      || typeof input.itemId !== "string" || !input.itemId || input.itemId.length > 300
      || !["confirm", "reject"].includes(input.decision)) {
      throw deviceError("INVALID_COLLABORATION_CONFIRMATION", 400);
    }
    const { sessionId } = this.session(id);
    const item = this.store.getSessionItem(sessionId, input.itemId);
    if (!item || (item.type !== "collaborationConfirmation"
      && item.presentationRole !== "collaboration_confirmation")) {
      throw deviceError("COLLABORATION_CONFIRMATION_NOT_PENDING", 409);
    }
    const existingStatus = item.collaborationConfirmationStatus ?? item.status;
    if (["confirmed", "rejected"].includes(existingStatus)) {
      return { schemaVersion: 1, sessionId, itemId: item.id, status: existingStatus };
    }
    if (existingStatus !== "pending" || typeof item.collaborationConfirmationId !== "string"
      || !item.collaborationConfirmationId) {
      throw deviceError("COLLABORATION_CONFIRMATION_NOT_PENDING", 409);
    }
    const responder = item.collaborationAuthorizationKind === "session_channel"
      ? this.respondToSessionChannelRequest : this.respondToCollaborationConfirmation;
    if (!responder) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (revalidateIdentity) {
      const current = revalidateIdentity();
      if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
    }
    const key = `${sessionId}:${item.collaborationConfirmationId}`;
    if (this.collaborationConfirmationsInFlight.has(key)) {
      throw deviceError("COLLABORATION_CONFIRMATION_IN_PROGRESS", 409);
    }
    this.collaborationConfirmationsInFlight.add(key);
    try {
      const result = await responder(item.collaborationConfirmationId, input.decision === "confirm",
        { type: "remote-client", deviceId: identity.deviceId, sessionId });
      const status = result?.status ?? (input.decision === "confirm" ? "confirmed" : "rejected");
      return { schemaVersion: 1, sessionId, itemId: item.id, status };
    } finally {
      this.collaborationConfirmationsInFlight.delete(key);
    }
  }

  /** Bytes of one managed attachment of this Session. Same ownership check as the desktop image route. */
  async resource(identity, id, query) {
    const { sessionId } = this.session(id);
    if ([...query.keys()].some(key => !["itemId", "path"].includes(key))
      || query.getAll("itemId").length !== 1 || query.getAll("path").length !== 1
      || !this.images?.readResource) throw deviceError("RESOURCE_NOT_AVAILABLE", 404);
    try {
      return await this.images.readResource(sessionId, query.get("itemId"), query.get("path"));
    } catch { throw deviceError("RESOURCE_NOT_AVAILABLE", 404); }
  }

  async image(identity, id, query) {
    const { sessionId } = this.session(id);
    if ([...query.keys()].some(k => k !== "path") || query.getAll("path").length !== 1) throw deviceError("INVALID_QUERY", 400);
    const managedPath = query.get("path");
    if (!managedPath || managedPath.length > 1024 || !this.images?.read) throw deviceError("IMAGE_NOT_AVAILABLE", 404);
    let image;
    try { image = await this.images.read(sessionId, managedPath); }
    catch (error) {
      // Foreign paths read as absent: the device must not learn which paths exist on the host.
      if ([403, 404].includes(error?.statusCode) || error?.code === "CHAT_IMAGE_FORBIDDEN" || error?.code === "CHAT_IMAGE_MISSING") throw deviceError("IMAGE_NOT_AVAILABLE", 404);
      if (error?.code === "CHAT_IMAGE_FORMAT_UNSUPPORTED") throw deviceError("IMAGE_NOT_AVAILABLE", 415);
      throw error;
    }
    return { data: image.data, contentType: image.mimeType, byteLength: image.byteLength };
  }

  /** Acknowledge agent messages through an exact cursor the device rendered; never "everything". */
  readReceipt(identity, id, input) {
    const { sessionId } = this.session(id);
    const through = input?.throughSequence;
    if (!Number.isSafeInteger(through) || through < 0 || Object.keys(input).some(key => key !== "throughSequence")) {
      throw deviceError("INVALID_READ_SEQUENCE", 400);
    }
    let receipt;
    try { receipt = this.markRead(sessionId, through); }
    catch (error) {
      if (error?.code === "INVALID_READ_SEQUENCE") throw deviceError("INVALID_READ_SEQUENCE", 409);
      if (error?.code === "SESSION_NOT_FOUND") throw deviceError("SESSION_NOT_AVAILABLE", 404);
      throw error;
    }
    return { schemaVersion: 1, sessionId,
      lastAgentMessageSequence: Number(receipt?.lastAgentMessageSequence ?? 0),
      lastReadMessageSequence: Number(receipt?.lastReadMessageSequence ?? 0) };
  }

  capabilities(identity, sessionId) {
    const resolved = this.session(sessionId);
    sessionId = resolved.sessionId;
    const actions = this.actions(resolved.session);
    const readiness = this.readiness ? this.readiness(resolved.session) : null;
    const notReadyReason = readiness?.notReadyReason && typeof readiness.notReadyReason === "object"
      ? { code: String(readiness.notReadyReason.code ?? "SESSION_NOT_READY"),
        message: String(readiness.notReadyReason.message ?? ""),
        retryable: typeof readiness.notReadyReason.retryable === "boolean" ? readiness.notReadyReason.retryable : null }
      : null;
    return { schemaVersion: 1, sessionId,
      readiness: readiness?.readiness === "ready" ? "ready" : readiness?.readiness === "not_ready" ? "not_ready" : null,
      notReadyReason: readiness?.readiness === "not_ready" ? notReadyReason : null,
      composer: Boolean(this.composer),
      cancelQueuedMessage: Boolean(this.cancelQueuedMessageHandler),
      deleteUnreceivedMessage: Boolean(this.deleteUserMessage),
      sendImages: Boolean(this.images?.available(resolved.session)),
      imageUploads: this.admitReliableMessage && this.images?.available(resolved.session) ? imageUploadPolicy : null,
      sendMentions: true,
      reliableMessages: this.admitReliableMessage ? { version: 1, maximumAgeSeconds: 604800, messageIdentityVersion: 2 } : null,
      scheduleMessage: Boolean(this.schedule),
      createTask: { available: Boolean(this.taskCreation) && Boolean(resolved.session.workId),
        reason: !this.taskCreation ? "CAPABILITY_UNSUPPORTED" : !resolved.session.workId ? "WORK_REQUIRED" : null },
      collaborationConfirmation: {
        available: Boolean(this.respondToCollaborationConfirmation || this.respondToSessionChannelRequest),
        reason: this.respondToCollaborationConfirmation || this.respondToSessionChannelRequest
          ? null : "CAPABILITY_UNSUPPORTED"
      },
      currentModel: resolved.session.external?.currentModel ?? null,
      currentReasoningLevel: resolved.session.external?.currentReasoningLevel ?? null,
      readMessages: true,
      send: { available: actions.send?.available === true, reason: actions.send?.reason ?? null },
      stop: { available: actions.interrupt?.available === true, reason: actions.interrupt?.reason ?? null } };
  }

  /** Context window and account quota of a Session: the desktop ChatUsageBar data, read-only. */
  async usage(identity, id, { cached = false, freshAccount = false } = {}) {
    const { sessionId, session } = this.session(id);
    if (!cached && !this.usageReader) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    const logical = this.store.getLogicalSessionByLegacySessionId?.(sessionId);
    const binding = logical?.activeBinding ?? null;
    const providerId = binding?.providerId ?? session.external?.provider ?? "unknown";
    const modelId = session.external?.currentModel ?? null;
    const storedContext = this.store.getSessionContextUsage?.(sessionId);
    const cachedSnapshot = {
      route: { providerId, model: modelId, bindingId: binding?.bindingId ?? null,
        routingVersion: binding?.routingVersion ?? logical?.routingVersion ?? null },
      context: storedContext?.providerId === providerId
        && (!storedContext.bindingId || !binding?.bindingId || storedContext.bindingId === binding.bindingId)
        ? storedContext.context : null,
      account: this.store.getProviderModelUsage?.(providerId, modelId)?.account ?? null
    };
    const snapshot = cached ? cachedSnapshot
      : await this.usageReader(sessionId, { requireFreshAccount: freshAccount });
    const number = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const window = value => value && typeof value === "object"
      ? { usedPercent: number(value.usedPercent), windowDurationMins: number(value.windowDurationMins), resetsAt: number(value.resetsAt) }
      : null;
    const limit = value => value && typeof value === "object"
      ? { limitId: value.limitId == null ? null : String(value.limitId), limitName: value.limitName == null ? null : String(value.limitName),
        primary: window(value.primary), secondary: window(value.secondary) }
      : null;
    const resetCredits = value => value && typeof value === "object"
      ? { availableCount: Number.isSafeInteger(value.availableCount) && value.availableCount >= 0 ? value.availableCount : null,
        credits: Array.isArray(value.credits) ? value.credits.filter(credit => credit && typeof credit === "object").map(credit => ({
          id: typeof credit.id === "string" ? credit.id : null,
          resetType: typeof credit.resetType === "string" ? credit.resetType : null,
          status: typeof credit.status === "string" ? credit.status : null,
          grantedAt: number(credit.grantedAt), expiresAt: number(credit.expiresAt),
          title: typeof credit.title === "string" ? credit.title : null,
          description: typeof credit.description === "string" ? credit.description : null
        })) : null }
      : null;
    const account = snapshot?.account && typeof snapshot.account === "object" ? snapshot.account : null;
    const context = snapshot?.context && typeof snapshot.context === "object" ? snapshot.context : null;
    const route = snapshot?.route ?? cachedSnapshot.route;
    return { schemaVersion: 1, sessionId,
      route: { providerId: String(route.providerId), modelId: route.model == null ? null : String(route.model),
        bindingId: route.bindingId == null ? null : String(route.bindingId),
        routingVersion: Number.isSafeInteger(route.routingVersion) ? route.routingVersion : null },
      accountFresh: cached ? false : snapshot?.accountFresh ?? null,
      context: context ? { usedTokens: number(context.usedTokens), contextWindow: number(context.contextWindow),
        remainingTokens: number(context.remainingTokens), usedPercent: number(context.usedPercent) } : null,
      account: account ? { available: account.available === true, provider: account.provider == null ? null : String(account.provider),
        model: account.model == null ? null : String(account.model), rateLimits: limit(account.rateLimits),
        rateLimitResetCredits: resetCredits(account.rateLimitResetCredits),
        rateLimitsByLimitId: account.rateLimitsByLimitId && typeof account.rateLimitsByLimitId === "object"
          ? Object.fromEntries(Object.entries(account.rateLimitsByLimitId).map(([key, value]) => [key, limit(value)]).filter(([, value]) => value))
          : null } : null };
  }

  async configuration(identity, id, input = null) {
    const { sessionId, session } = this.session(id);
    if (!this.composer) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (input !== null) {
      if (!input || Array.isArray(input) || typeof input !== "object"
          || Object.keys(input).length !== 1) throw deviceError("INVALID_CONFIGURATION", 400);
      const key = Object.keys(input)[0];
      if (!["model", "reasoningLevel"].includes(key) || typeof input[key] !== "string"
          || !input[key].trim() || input[key].length > 256) throw deviceError("INVALID_CONFIGURATION", 400);
      const action = this.actions(session)[key === "model" ? "switchModel" : "switchReasoning"];
      if (action?.available !== true) throw deviceError(action?.reason ?? "CAPABILITY_UNSUPPORTED", 409);
      await this.composer.update(sessionId, key, input[key]);
    }
    const catalog = await this.composer.read(sessionId);
    const actions = this.actions(this.session(sessionId).session);
    return { schemaVersion: 1, sessionId, currentModel: catalog.currentModel ?? null,
      currentReasoningLevel: catalog.currentReasoningLevel ?? null,
      models: (catalog.models ?? []).map(model => ({ id: model.id, name: model.name,
        reasoningLevels: model.reasoningLevels ?? [], defaultReasoningLevel: model.defaultReasoningLevel ?? null })),
      switchModel: actions.switchModel ?? { available: false },
      switchReasoning: actions.switchReasoning ?? { available: false } };
  }

  receipt(identity, requestId) {
    const reliable = reliableReceipt(this.store, identity, requestId);
    if (reliable) return reliable;
    const row = this.store.selectOne("SELECT * FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, requestId]);
    if (!row) throw deviceError("COMMAND_NOT_FOUND", 404);
    const key = `${identity.deviceId}:${requestId}`;
    if (row.kind === "send" && ["dispatching", "unknown"].includes(row.status) && !this.inFlight.has(key)) {
      const deliveryId = `delivery:client:${createHash("sha256").update(key).digest("hex")}`;
      if (this.store.getMessageDelivery?.(deliveryId)) {
        this.update(identity.deviceId, requestId, "accepted", null);
        return this.receipt(identity, requestId);
      }
    }
    return { schemaVersion: 1, requestId: row.request_id, sessionId: row.session_id, kind: row.kind,
      status: row.status === "dispatching" && !this.inFlight.has(key) ? "unknown" : row.status,
      errorCode: row.error_code, updatedAt: row.updated_at,
      ...(row.kind === "send" && row.status === "accepted" && this.store.getMessageDelivery?.(`delivery:client:${createHash("sha256").update(key).digest("hex")}`)
        ? { messageId: `client:${createHash("sha256").update(key).digest("hex")}` } : {}),
      ...(row.result_json ? { [row.kind === "create_task" ? "taskResult" : row.kind === "open_work_discussion" ? "discussionResult"
        : row.kind.startsWith("inspector:") ? "inspectorResult"
        : /^(task|work)_/.test(row.kind) ? "entityResult" : "commandResult"]: JSON.parse(row.result_json) } : {}) };
  }

  async commandCatalog(identity, id) {
    const { sessionId } = this.session(id);
    if (!this.conversationCommands) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    const commands = await this.conversationCommands.list(sessionId);
    return { schemaVersion: 1, sessionId, commands: commands.map(({ requiredPermissions: _, ...command }) => ({
      ...command,
      canMutate: true
    })) };
  }

  async conversationCommand(identity, id, input, revalidateIdentity = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["requestId", "name", "arguments", "confirmed"].includes(key))
        || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")
        || (input.confirmed !== undefined && typeof input.confirmed !== "boolean")) throw deviceError("INVALID_COMMAND", 400);
    const command = { name: input.name, arguments: input.arguments };
    validateSessionCommand(command);
    // Fingerprint the submitted target, not a binding that a command may replace.
    const fingerprint = createHash("sha256").update(JSON.stringify([id, "conversation_command", command.name, command.arguments])).digest("hex");
    const existing = this.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, input.requestId]);
    if (existing) {
      if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.receipt(identity, input.requestId);
    }
    const { sessionId } = this.session(id);
    if (sessionCommandNeedsConfirmation(command) && input.confirmed !== true) throw deviceError("COMMAND_CONFIRMATION_REQUIRED", 409);
    if (!this.conversationCommands) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    await this.conversationCommands.validate(sessionId, command);
    if (revalidateIdentity) {
      const current = revalidateIdentity();
      if (current.deviceId !== identity.deviceId) throw deviceError("INVALID_CREDENTIAL", 401);
      identity = current;
    }
    // Validation may await a capability read. Claim synchronously afterwards;
    // a concurrent copy may have created the receipt while it was suspended.
    const raced = this.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, input.requestId]);
    if (raced) {
      if (raced.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.receipt(identity, input.requestId);
    }
    if (this.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count >= 10000) throw deviceError("COMMAND_JOURNAL_FULL", 503);
    const now = new Date().toISOString(), key = `${identity.deviceId}:${input.requestId}`;
    this.store.db.run(`INSERT INTO client_command_receipts
      (device_id, request_id, session_id, kind, payload_hash, status, error_code, created_at, updated_at)
      VALUES (?, ?, ?, 'conversation_command', ?, 'dispatching', NULL, ?, ?)`,
      [identity.deviceId, input.requestId, sessionId, fingerprint, now, now]);
    this.inFlight.add(key);
    try {
      const result = await this.conversationCommands.execute(sessionId, command,
        { type: "remote-client", deviceId: identity.deviceId, requestId: input.requestId,
          messageId: `client:${createHash("sha256").update(key).digest("hex")}` });
      // Explicit public projection, never expose raw Provider payloads.
      const text = typeof result?.text === "string" ? result.text : "命令已执行。";
      this.update(identity.deviceId, input.requestId, "completed", null,
        { text: text.slice(0, 64000), truncated: text.length > 64000,
          ...(result?.conversationCleared === true ? { conversationCleared: true } : {}),
          ...(typeof result?.messageId === "string" ? { messageId: result.messageId } : {}) });
    } catch (error) {
      const rejected = error.commandStage === "validation";
      this.update(identity.deviceId, input.requestId, rejected ? "rejected" : "unknown",
        rejected ? error.code ?? "INVALID_COMMAND_ARGUMENTS" : "COMMAND_OUTCOME_UNCERTAIN");
    } finally { this.inFlight.delete(key); }
    return this.receipt(identity, input.requestId);
  }

  reliableMessage(identity, sessionId, input, authenticate) {
    return acceptReliableMessage(this, identity, sessionId, input, authenticate);
  }

  async command(identity, sessionId, kind, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(k => !["requestId", ...(kind === "send" ? ["text", "images", "mentions", "schedule"] : [])].includes(k))
        || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")) throw deviceError("INVALID_COMMAND", 400);
    if (kind === "send" && (typeof input.text !== "string" || (!input.text.trim() && !input.images?.length) || input.text.length > 16000
      || parseSlashCommand(input.text))) throw deviceError("INVALID_MESSAGE", 400);
    const resolved = this.session(sessionId);
    sessionId = resolved.sessionId;
    const images = input.images ?? [], mentions = input.mentions ?? [];
    if (!Array.isArray(images) || images.length > 8 || images.some(image => !image || typeof image !== "object"
      || Object.keys(image).some(key => !["fileName", "dataBase64"].includes(key))
      || typeof image.fileName !== "string" || image.fileName.length > 256
      || typeof image.dataBase64 !== "string" || image.dataBase64.length > 28 * 1024 * 1024
      || image.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64)
      || !image.dataBase64.length)
      || images.reduce((sum, image) => sum + image.dataBase64.length / 4 * 3
        - (image.dataBase64.endsWith("==") ? 2 : image.dataBase64.endsWith("=") ? 1 : 0), 0) > 20 * 1024 * 1024) throw deviceError("INVALID_IMAGES", 400);
    if (images.length && !this.images?.available(resolved.session)) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
    if (!Array.isArray(mentions) || mentions.length > 8 || mentions.some(mention => !mention
      || Object.keys(mention).some(key => !["targetType", "targetId", "displayName"].includes(key))
      || !["work", "session"].includes(mention.targetType) || typeof mention.targetId !== "string"
      || !mention.targetId.trim() || mention.targetId.length > 200 || typeof mention.displayName !== "string"
      || !mention.displayName || mention.displayName.length > 200)) throw deviceError("INVALID_MENTIONS", 400);
    if (input.schedule !== undefined) {
      const schedule = input.schedule;
      if (!this.schedule) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
      if (!schedule || Array.isArray(schedule) || typeof schedule !== "object" || images.length || mentions.length
        || Object.keys(schedule).some(key => !["runAt", "expiresAt", "intervalSeconds"].includes(key))
        || typeof schedule.runAt !== "string" || !Number.isFinite(Date.parse(schedule.runAt))
        || typeof schedule.expiresAt !== "string" || !Number.isFinite(Date.parse(schedule.expiresAt))
        || Date.parse(schedule.expiresAt) <= Date.parse(schedule.runAt)
        || (schedule.intervalSeconds != null && (!Number.isInteger(schedule.intervalSeconds)
          || schedule.intervalSeconds < 60 || schedule.intervalSeconds > 31536000))) throw deviceError("INVALID_SCHEDULE", 400);
    }
    // Preserve the fingerprint of existing text-only receipts across upgrades.
    const payload = [sessionId, kind, input.text ?? null];
    if (images.length || mentions.length) payload.push(images, mentions);
    if (input.schedule) payload.push(input.schedule);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const existing = this.store.selectOne("SELECT payload_hash FROM client_command_receipts WHERE device_id = ? AND request_id = ?", [identity.deviceId, input.requestId]);
    if (existing) {
      if (existing.payload_hash !== fingerprint) throw deviceError("IDEMPOTENCY_CONFLICT", 409);
      return this.receipt(identity, input.requestId);
    }
    if (input.schedule && Date.parse(input.schedule.runAt) <= Date.now()) throw deviceError("INVALID_SCHEDULE", 400);
    const actions = this.actions(resolved.session);
    const action = kind === "send" ? actions.send : actions.interrupt;
    if (action?.available !== true) throw deviceError(action?.reason ?? "CAPABILITY_UNSUPPORTED", 409);
    // Bound retention without silently evicting deduplication keys.
    const count = this.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count;
    if (count >= 10000) throw deviceError("COMMAND_JOURNAL_FULL", 503);
    const now = new Date().toISOString(), key = `${identity.deviceId}:${input.requestId}`;
    this.store.db.run(`INSERT INTO client_command_receipts
      (device_id, request_id, session_id, kind, payload_hash, status, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'dispatching', NULL, ?, ?)`,
      [identity.deviceId, input.requestId, sessionId, kind, fingerprint, now, now]);
    this.inFlight.add(key);
    const commandSource = { type: "remote-client", deviceId: identity.deviceId,
      messageId: `client:${createHash("sha256").update(key).digest("hex")}` };
    try {
      if (kind === "send" && input.schedule) await this.schedule(sessionId, input.text, input.schedule, identity);
      else if (kind === "send") {
        const attachments = [];
        for (const image of images) attachments.push(await this.images.import(sessionId, image));
        await this.send(sessionId, { text: input.text, ...(attachments.length ? { images: attachments } : {}),
          ...(mentions.length ? { mentions } : {}) }, commandSource);
      }
      else await this.stop(sessionId, commandSource);
      this.update(identity.deviceId, input.requestId, kind === "send" ? "accepted" : "stop_requested", null);
    } catch {
      // Failure can occur after side effects. Never auto-replay an uncertain command.
      this.update(identity.deviceId, input.requestId, "unknown", "COMMAND_OUTCOME_UNCERTAIN");
    } finally { this.inFlight.delete(key); }
    return this.receipt(identity, input.requestId);
  }

  update(deviceId, requestId, status, errorCode, result = null) {
    this.store.db.run("UPDATE client_command_receipts SET status = ?, error_code = ?, updated_at = ?, result_json = ? WHERE device_id = ? AND request_id = ?",
      [status, errorCode, new Date().toISOString(), result ? JSON.stringify(result) : null, deviceId, requestId]);
    try { this.onReceiptChanged?.(deviceId, this.receipt({ deviceId }, requestId)); } catch {}
  }
}
